export interface AIAnalysisResult {
  isAppropriate: boolean;
  category: string;
  tags: string[];
  refinedTitle?: string;
  refinedContent?: string;
  advice?: string;
}

export const analyzeProposal = async (title: string, content: string): Promise<AIAnalysisResult> => {
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, content }),
    });

    if (!response.ok) {
      throw new Error(`Server status: ${response.status}`);
    }

    const data = await response.json();
    return data as AIAnalysisResult;

  } catch (error: any) {
    console.warn("AI Analysis Error (Client):", error);
    
    return {
      isAppropriate: false,
      category: "通信エラー",
      tags: ["#エラー", "#投稿不可"],
      refinedTitle: title,
      refinedContent: content,
      advice: "AI安全チェックサーバーと通信できませんでした。安全確認が完了するまで意見は投稿できません。時間をおいてからやり直してください。"
    };
  }
};

