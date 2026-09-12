import express from "express";
import path from "path";
import { GoogleGenAI } from "@google/genai";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Security Middleware
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  // Limit JSON payload to prevent DOS attacks
  app.use(express.json({ limit: "50kb" }));

  // In-memory rate limiter for AI analysis endpoint (15 requests per minute per IP)
  const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
  const RATE_LIMIT_WINDOW_MS = 60 * 1000;
  const RATE_LIMIT_MAX_REQUESTS = 15;

  // API route for Gemini
  app.post("/api/analyze", async (req, res) => {
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rateData = rateLimitMap.get(clientIp);

    if (rateData && now < rateData.resetTime) {
      if (rateData.count >= RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({
          isAppropriate: false,
          category: "アクセス制限",
          tags: ["#レート制限"],
          refinedTitle: typeof req.body?.title === 'string' ? req.body.title : '',
          refinedContent: typeof req.body?.content === 'string' ? req.body.content : '',
          advice: "短時間に連続でAIチェックが実行されました。安全のため1分ほど時間をあけてから再試行してください。"
        });
      }
      rateData.count++;
    } else {
      rateLimitMap.set(clientIp, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    }

    // Input validation & sanitization
    const rawTitle = req.body?.title;
    const rawContent = req.body?.content;

    if (typeof rawTitle !== "string" || typeof rawContent !== "string") {
      return res.status(400).json({
        isAppropriate: false,
        category: "入力エラー",
        tags: ["#不正データ"],
        refinedTitle: "",
        refinedContent: "",
        advice: "入力データ形式が無効です。タイトルと本文を正しく入力してください。"
      });
    }

    const title = rawTitle.trim();
    const content = rawContent.trim();

    if (!title || !content) {
      return res.json({
        isAppropriate: false,
        category: 'その他',
        tags: ['#未入力'],
        refinedTitle: title,
        refinedContent: content,
        advice: 'タイトルと内容の両方を入力してください。'
      });
    }

    if (title.length > 200 || content.length > 5000) {
      return res.status(400).json({
        isAppropriate: false,
        category: '文字数超過',
        tags: ['#文字数制限'],
        refinedTitle: title.slice(0, 200),
        refinedContent: content.slice(0, 5000),
        advice: 'タイトルは200文字以内、内容は5000文字以内で入力してください。'
      });
    }

    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.json({
          isAppropriate: false,
          category: 'システムエラー',
          tags: ['#設定未完了'],
          refinedTitle: title,
          refinedContent: content,
          advice: 'AIシステムのキー設定が確認できないため、安全確保のため投稿を受け付けることができません。システム管理者にご確認ください。'
        });
      }

      const ai = new GoogleGenAI({ 
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const systemPrompt = `
あなたは公立中学校の生徒会公式「デジタル目安箱:ProPoSal」専属のAIアドバイザー兼安全モデレーターです。
生徒たちから寄せられる学校改善の意見・アイデアを公平かつ建設的に審査し、先生方や生徒会役員、全校生徒にしっかり伝わる説得力のある提案書形式に推敲（ブラッシュアップ）する役割を担っています。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【基本姿勢・マインドセット（最重要ルール）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 【生徒が書いた「現場の実態・困りごと」を100%正しい事実として尊重する】
   - 生徒が「今は体操着登校は認められているがジャージは禁止されている」「雨の日に制服が濡れて一日中不快」「荷物が重くて肩が痛い」などと書いている場合、その現場の状況や季節ごとの実情を100%正しい前提として受け止めてください。
   - 学校現場には、生徒手帳の文字面だけでなく、年度や季節、校長や学年の方針によって柔軟に運用されているルール（体操着登校の特例など）が数多く存在します。

2. 【「現在の校則では〜」という杓子定規な決めつけ・引用を一切禁止】
   - 推敲文（refinedContent）やアドバイス（advice）の中で、「現在の校則では制服が原則となっていますが…」「校則第〇条に反しますが…」といったような、頭ごなしのお説教や校則の文面を引用した否定・前置きは【厳格に禁止】します。
   - 生徒が書いた言葉と意図をそのまま汲み取り、「生徒の視点に立った提案書」として文章を構成してください。

3. 【目安箱の使命は「現状をより良くアップデートする」こと】
   - 目安箱は校則を取り締まるための警察ではなく、生徒の健康、安全、学びやすさのために「既存のルールや生活環境を健全に発展・見直しする」ための民主的なプラットフォームです。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【判定基準（3つのチェックステップ）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ ステップ1：【公序良俗・人権・安全のチェック】
以下のいずれかに該当する場合は、直ちに【isAppropriate: false】と判定してください。
- 誹謗中傷、特定の教職員（先生の実名・あだ名等）や特定の生徒個人への攻撃・陰湿な批判・不満・晒し
- 差別的な言動、暴力・いじめの肯定、性的な話題、違法行為や危険行為の示唆
- 意味をなさない文字列（「あああ」「test」「ふざけ」など）や明らかな落書き・いたずら

◆ ステップ2：【公立中学校の学習規律・健全性のチェック】
以下のいずれかに該当する場合は、【isAppropriate: false】と判定してください。
- 学業のサボり・怠惰な要求（★最重要却下項目）:
  - 「テストの難易度を下げてほしい」「テストを簡単にしてほしい」「テストの回数を減らしてほしい・廃止してほしい」
  - 「宿題・ワークをなくしてほしい・減らしてほしい」「提出物を廃止してほしい」
  - ※理由: 学習指導要領に基づき生徒の基礎学力を育むための教育活動であり、楽をしたいという要求は目安箱の趣旨に反します。
- 学校内での純粋な娯楽・サボり要求:
  - 「ゲーム機や漫画を持ち込みたい」「授業中にスマホで遊びたい」「授業をサボりたい」
- 公立中学生として明らかに規律を逸脱した要求:
  - 派手な金髪染髪、タトゥー、ピアス、フルメイクの自由化、中学生のアルバイト解禁、登下校中の買い食い・寄り道の公認など

◆ ステップ3：【学校改善・生活向上としての妥当性チェック】
上記のNG事項に該当せず、生徒の学校生活をより良くするための前向きな意見であれば、広く【isAppropriate: true】と判定してください！
【歓迎される提案の典型例（すべて isAppropriate: true）】:
- 健康・安全・寒暖差対策:
  - ジャージ登校・体操着登校の柔軟な許可（熱中症対策、雨天時の制服濡れ防止、寒暖差対策、体育のある日など）
  - 防寒具（ウィンドブレーカー、コート、マフラー、手袋、ヒートテック、カイロ等）の指定緩和・着用期間の柔軟化
  - 靴下やインナーの色・丈・素材の柔軟化（泥はね対策、黒・紺色の許可など）
  - 頭髪・身だしなみの合理的見直し（ツーブロックの許可、結ぶ位置やヘアゴムの自由度向上など）
  - 熱中症対策（水筒の中身にスポーツドリンク等の許可、日傘、冷却シート、ネッククーラーの利用など）
- 負担軽減・環境整備:
  - 通学時の荷物軽減（置き勉の範囲拡大、サブバッグの活用）
  - 校内設備・美化（トイレの洋式化・ハンドソープ常備、自習スペースの確保、図書室の開館時間延長、体育・部活器具の貸出ルールなど）
  - 生徒会・学校行事の工夫（体育祭・合唱祭の運営、意見箱の周知など）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【出力項目の指示】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. isAppropriate: 上記基準に基づき true または false。
2. category: 「校則・生活」「設備・環境」「生徒会・行事」「その他」から最も適したものを1つ選択。
3. tags: 提案を象徴するハッシュタグ（#付き）を2〜3個（例: ["#服装規定", "#ジャージ登校", "#熱中症対策"]）。
4. refinedTitle:
   - trueの場合: 生徒会や職員会議で議題として取り上げやすい、具体的で礼儀正しいタイトル。
     （例: 「ジャージ登校可能にして」→「【熱中症・雨天時対策】ジャージ登校の柔軟な導入について」）
   - falseの場合: 入力された元のタイトルをそのまま。
5. refinedContent:
   - trueの場合: 生徒の言葉や要望の趣旨を100%生かしつつ、先生方や生徒会にそのまま提出できる「敬語を用いた説得力のある提案書」の形に推敲してください。
     構成の目安：
     ①【現状の課題・背景】（生徒が挙げた具体的な理由を尊重）
     ②【具体的な改善案】（例: 「夏季や雨天時、体育のある日などに限定した導入」「まずは1ヶ月間の試験運用の検討」など、学校側が受け入れやすい現実的な工夫を盛り込む）
     ③【期待される効果】（生徒の健康・安全、学習への集中、保護者の負担軽減など）
     ※「現在の校則では〜」という前置きや講釈は絶対に含めないでください。
   - falseの場合: 入力された元の内容をそのまま。
6. advice:
   - trueの場合: 提案の着眼点を温かく称賛し、生徒総会や先生方との対話で「さらに実現性を高めるための実践的なアドバイス」を提供してください。
     （例: 「とても具体的で説得力のある着眼点ですね！全校アンケートで『雨の日に制服が濡れて困った経験がある生徒の割合』などのデータを添えたり、『まずは体育のある曜日限定のトライアル導入』として提案すると、先生方や保護者からも一段と賛同を得やすくなりますよ。」など）
   - falseの場合: 中学生に向けて、なぜ目安箱で取り扱えないのか（公序良俗、学習基準への影響、中学生としての規律など）を分かりやすく優しい口調で解説し、前向きな視点への見直しを提案してください。
`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `タイトル: ${title}\n内容: ${content}`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              isAppropriate: { type: "BOOLEAN" },
              category: { type: "STRING" },
              tags: { type: "ARRAY", items: { type: "STRING" } },
              refinedTitle: { type: "STRING" },
              refinedContent: { type: "STRING" },
              advice: { type: "STRING" },
            },
            required: ["isAppropriate", "category", "tags", "refinedTitle", "refinedContent", "advice"],
          },
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error("AIからの応答が空でした");
      }
      
      const parsed = JSON.parse(text);

      // サーバー側バックアップ安全チェック（テスト容易化・宿題削減の確実なブロック）
      const combinedText = (title + " " + content).toLowerCase();
      const testEasePattern = /(テスト|定期考査|考査|単元テスト|中間|期末).*(簡単|かんたん|やさしく|難易度.*下|下げ|低く|廃止|なくし|やめ|減ら)/;
      const homeworkCutPattern = /(宿題|課題|ワーク|提出物).*(なくし|減ら|廃止|やめ|いらない|ゼロ|なし)/;
      
      if (testEasePattern.test(combinedText) || homeworkCutPattern.test(combinedText)) {
        parsed.isAppropriate = false;
        parsed.category = "学業・学習";
        if (!parsed.tags || parsed.tags.length === 0) {
          parsed.tags = ["#学習基準", "#目安箱対象外"];
        }
        parsed.advice = "【目安箱の対象外です】テストの難易度や出題範囲、宿題などの学習基準は、学習指導要領に基づき生徒の基礎学力を保障するために定められています。単に『テストを簡単にしてほしい』『宿題を減らしてほしい』という要望は目安箱では受け付けられません。もし『放課後に質問しやすい自習環境を作ってほしい』など、前向きな学習環境の改善提案があれば、そちらをご検討ください。";
      }

      res.json(parsed);
    } catch (error: any) {
      console.warn("AI Analysis Error:", error.message || error);
      const isQuota = /quota|429|resource_exhausted|rate-limit/i.test(error.message || '');
      
      if (isQuota) {
        return res.json({
          isAppropriate: false,
          category: '受付一時停止',
          tags: ['#API上限', '#受付停止中'],
          refinedTitle: title,
          refinedContent: content,
          advice: '【投稿受付停止中】今月のAIチェック利用枠の上限に達したため、安全確保のため現在新しい意見の投稿を一時停止しています。申し訳ありません！時間をおいて再度お試しいただくか、生徒会役員・担当の先生まで直接ご相談ください。'
        });
      }

      return res.json({
        isAppropriate: false,
        category: 'エラー',
        tags: ['#チェック失敗', '#再試行のお願い'],
        refinedTitle: title,
        refinedContent: content,
        advice: '【AIチェック失敗】AI安全チェック処理を実行できませんでした。安全確認が完了していない意見は投稿できません。通信状態をご確認の上、もう一度「チェック＆推敲実行」をお試しください！'
      });
    }
  });


  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
