import React, { useState, useEffect, useMemo } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { 
  auth, 
  loginWithGoogle, 
  logoutFromFirebase, 
  subscribeToUserProfile, 
  subscribeToAllUsers, 
  subscribeToProposals, 
  addProposalToFirestore, 
  toggleSignatureInFirestore, 
  updateProposalByAdmin, 
  approveUserInFirestore, 
  rejectUserInFirestore, 
  updateUserProfileInFirestore,
  deleteProposalFromFirestore,
  seedInitialProposalsIfEmpty,
  UserProfile, 
  Proposal, 
  Signature,
  ADMIN_EMAIL,
  ALLOWED_DOMAIN
} from './services/firebase';
import { analyzeProposal, AIAnalysisResult } from './services/geminiService';
import { SCHOOL_RULES_SECTIONS, SCHOOL_RULES_TEXT } from './schoolRules';

// --- Constants ---
const STATUS_STEPS: Proposal['status'][] = ['受付中', '検討中', '先生と調整中', '対応済'];
const CATEGORIES: Proposal['category'][] = ['校則', '設備・環境', '授業', 'その他'];

// --- Helper Components ---
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const colors: Record<string, string> = {
    '受付中': 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200 border border-blue-200 dark:border-blue-800',
    '検討中': 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200 border border-yellow-200 dark:border-yellow-800',
    '先生と調整中': 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200 border border-purple-200 dark:border-purple-800',
    '対応済': 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200 border border-green-200 dark:border-green-800',
  };
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-black tracking-wider inline-flex items-center gap-1 ${colors[status] || 'bg-gray-100 text-gray-800'}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
      {status}
    </span>
  );
};

const Stepper: React.FC<{ currentStatus: string }> = ({ currentStatus }) => {
  const currentIndex = STATUS_STEPS.indexOf(currentStatus as any);
  
  return (
    <div className="relative flex justify-between items-center mb-12 px-4">
      <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-200 dark:bg-gray-700 -z-0 -translate-y-1/2 rounded-full"></div>
      {STATUS_STEPS.map((step, idx) => {
        const isCompleted = idx < currentIndex;
        const isActive = idx === currentIndex;
        return (
          <div key={step} className="relative z-10 flex flex-col items-center">
            <div 
              className={`w-11 h-11 rounded-full flex items-center justify-center font-black text-sm transition-all duration-300 border-2 ${
                isCompleted || isActive 
                  ? 'bg-primary border-primary text-white shadow-lg shadow-primary/30 scale-110' 
                  : 'bg-white dark:bg-bg-cardDark border-gray-300 dark:border-gray-700 text-gray-400'
              }`}
            >
              {isCompleted ? <span className="material-icons-round text-lg">check</span> : <span>{idx + 1}</span>}
            </div>
            <span className={`absolute top-13 whitespace-nowrap text-xs font-black transition-colors ${isActive ? 'text-primary dark:text-primary-light font-extrabold' : 'text-gray-400'}`}>
              {step}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// --- Main App Component ---
const App: React.FC = () => {
  // Auth & Profile
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);

  // Navigation & View
  const [view, setView] = useState<'home' | 'proposals' | 'status' | 'rules' | 'login' | 'admin' | 'mypage'>('home');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Rules View & Search States
  const [rulesSearch, setRulesSearch] = useState('');
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>('rules-3');
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);

  // Proposals Data
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);

  // Search & Filter
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // Modals & UI States
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [isPostModalOpen, setIsPostModalOpen] = useState(false);
  const [adminTab, setAdminTab] = useState<'dashboard' | 'approvals' | 'users'>('dashboard');
  const [dialog, setDialog] = useState<{ message: string; title?: string; type: 'alert' | 'confirm'; onConfirm?: () => void } | null>(null);

  // My Page Edit State
  const [isEditingClass, setIsEditingClass] = useState(false);
  const [myClassInput, setMyClassInput] = useState('');

  // Proposal Creation Form
  const [postForm, setPostForm] = useState({ title: '', content: '' });
  const [approvedPostForm, setApprovedPostForm] = useState({ title: '', content: '' });
  const [aiResult, setAiResult] = useState<{ loading: boolean; result: AIAnalysisResult | null }>({ loading: false, result: null });
  const [isAIApproved, setIsAIApproved] = useState(false);

  // Admin Edit Modal
  const [adminEditId, setAdminEditId] = useState<string | null>(null);
  const [adminResponseText, setAdminResponseText] = useState('');
  const [adminStatusSelect, setAdminStatusSelect] = useState<Proposal['status']>('受付中');

  // --- Initial Setup & Firebase Listeners ---
  useEffect(() => {
    const savedTheme = localStorage.getItem('proposal_theme') as 'light' | 'dark';
    if (savedTheme) {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('proposal_theme', theme);
  }, [theme]);

  // Auth State Listener
  useEffect(() => {
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        if (!firebaseUser.email || !firebaseUser.email.endsWith(ALLOWED_DOMAIN)) {
          setCurrentUser(null);
          setAuthLoading(false);
          return;
        }

        // Subscribe to user profile document in Firestore
        unsubscribeProfile = subscribeToUserProfile(firebaseUser.uid, (profile) => {
          if (profile) {
            setCurrentUser(profile);
            setMyClassInput(profile.class || '');
          } else {
            // Document might still be creating
            const isAdmin = firebaseUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
            setCurrentUser({
              uid: firebaseUser.uid,
              name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'ユーザー',
              email: firebaseUser.email || '',
              photoURL: firebaseUser.photoURL || '',
              role: isAdmin ? 'admin' : 'student',
              isApproved: isAdmin,
              createdAt: new Date().toISOString(),
            });
          }
          setAuthLoading(false);
        });
      } else {
        if (unsubscribeProfile) unsubscribeProfile();
        setCurrentUser(null);
        setAuthLoading(false);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeProfile) unsubscribeProfile();
    };
  }, []);

  // Proposals Firestore Real-time Listener
  useEffect(() => {
    // Seed initial data if database is fresh
    seedInitialProposalsIfEmpty().catch(console.error);

    const unsubscribeProposals = subscribeToProposals((data) => {
      setProposals(data);
      setProposalsLoading(false);
    });

    return () => unsubscribeProposals();
  }, []);

  // Admin: All Users Listener
  useEffect(() => {
    if (currentUser?.role === 'admin') {
      const unsubscribeUsers = subscribeToAllUsers((users) => {
        setAllUsers(users);
      });
      return () => unsubscribeUsers();
    }
  }, [currentUser?.role]);

  // AI Re-validation if user edits input after analysis
  useEffect(() => {
    if (isAIApproved && (postForm.title !== approvedPostForm.title || postForm.content !== approvedPostForm.content)) {
      setIsAIApproved(false);
      setAiResult({ loading: false, result: null });
    }
  }, [postForm, isAIApproved, approvedPostForm]);

  // --- Handlers ---
  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const profile = await loginWithGoogle();
      setCurrentUser(profile);
      setMyClassInput(profile.class || '');
      setView('home');
      setDialog({
        title: "ログイン完了",
        message: `ようこそ、${profile.name}さん！（${profile.email}）\n${profile.role === 'admin' ? '生徒会管理者権限が付与されました。' : profile.isApproved ? '承認済みアカウントとして全機能をご利用いただけます。' : 'アカウントが作成されました。生徒会の承認完了後に署名が可能になります。'}`,
        type: 'alert'
      });
    } catch (error: any) {
      console.error("Login Error:", error);
      setDialog({
        title: "ログイン失敗",
        message: error.message || "Googleログインに失敗しました。もう一度お試しください。",
        type: 'alert'
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logoutFromFirebase();
      setCurrentUser(null);
      setView('home');
    } catch (error) {
      console.error("Logout Error:", error);
    }
  };

  const handleSaveProfile = async () => {
    if (!currentUser) return;
    try {
      await updateUserProfileInFirestore(currentUser.uid, {
        class: myClassInput.trim(),
      });
      setIsEditingClass(false);
      setDialog({ message: "学年・クラス情報を更新しました。", type: 'alert' });
    } catch (error) {
      console.error("Profile update error:", error);
      setDialog({ message: "学年・クラス情報の更新に失敗しました。", type: 'alert' });
    }
  };

  const handleDeleteAccount = () => {
    if (!currentUser) return;
    setDialog({
      title: "アカウント削除の確認",
      message: "本当にアカウントを削除しますか？登録情報がデータベースから消去されます。",
      type: 'confirm',
      onConfirm: async () => {
        try {
          await rejectUserInFirestore(currentUser.uid);
          await logoutFromFirebase();
          setCurrentUser(null);
          setView('home');
          setDialog({ message: "アカウント情報を削除しました。", type: 'alert' });
        } catch (error) {
          console.error("Account delete error:", error);
        }
      }
    });
  };

  const handleApproveUser = async (uid: string) => {
    try {
      await approveUserInFirestore(uid);
    } catch (error) {
      console.error("Approve error:", error);
      setDialog({ message: "承認処理に失敗しました。", type: 'alert' });
    }
  };

  const handleRejectUser = async (uid: string) => {
    try {
      await rejectUserInFirestore(uid);
    } catch (error) {
      console.error("Reject error:", error);
      setDialog({ message: "削除処理に失敗しました。", type: 'alert' });
    }
  };

  const handleChangeUserRole = async (uid: string, role: 'student' | 'teacher' | 'admin') => {
    try {
      await updateUserProfileInFirestore(uid, { role });
    } catch (error) {
      console.error("Role update error:", error);
    }
  };

  const handleAIAnalyze = async () => {
    if (!postForm.title.trim() || !postForm.content.trim()) {
      return setDialog({ message: "タイトルと内容を入力してください", type: 'alert' });
    }
    setAiResult({ loading: true, result: null });
    try {
      const result = await analyzeProposal(postForm.title, postForm.content);
      setAiResult({ loading: false, result });
      if (result.isAppropriate) {
        setPostForm({ 
          title: result.refinedTitle || postForm.title, 
          content: result.refinedContent || postForm.content 
        });
        setApprovedPostForm({ 
          title: result.refinedTitle || postForm.title, 
          content: result.refinedContent || postForm.content 
        });
        setIsAIApproved(true);
      } else {
        setIsAIApproved(false);
      }
    } catch (error) {
      setAiResult({ loading: false, result: null });
      setDialog({ message: "AI分析中に通信エラーが発生しました。時間をおいて再度お試しください。", type: 'alert' });
    }
  };

  const handlePostSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAIApproved || !aiResult.result) return;
    if (!currentUser) {
      setDialog({ message: "意見を投稿するには学校アカウントでログインしてください。", type: 'alert' });
      return;
    }

    try {
      await addProposalToFirestore({
        title: postForm.title.trim(),
        content: postForm.content.trim(),
        category: (aiResult.result.category as any) || 'その他',
        status: '受付中',
        adminResponse: '',
        timestamp: new Date().toISOString(),
        signatures: [],
        authorId: currentUser.uid,
        authorName: currentUser.name,
        authorEmail: currentUser.email,
      });

      setIsPostModalOpen(false);
      setPostForm({ title: '', content: '' });
      setIsAIApproved(false);
      setAiResult({ loading: false, result: null });
      setView('proposals');
      setDialog({
        title: "投稿完了",
        message: "意見が目安箱に正常に投稿されました！全校生徒・先生・生徒会で共有されます。",
        type: 'alert'
      });
    } catch (error) {
      console.error("Submit Proposal Error:", error);
      setDialog({ message: "意見の投稿に失敗しました。通信状態を確認してください。", type: 'alert' });
    }
  };

  const handleToggleSignature = async (proposalId: string) => {
    if (!currentUser) {
      setDialog({ 
        message: "署名（賛同）するには「@toda-ed.jp」のGoogleアカウントでのログインが必要です。", 
        type: 'alert' 
      });
      setView('login');
      return;
    }
    if (!currentUser.isApproved) {
      setDialog({ 
        title: "承認待ち", 
        message: "あなたのアカウントは現在【生徒会の承認待ち】です。いたずら防止のため、生徒会による承認が完了するまで署名機能は制限されます。", 
        type: 'alert' 
      });
      return;
    }

    const targetProposal = proposals.find((p) => p.id === proposalId);
    if (!targetProposal) return;

    try {
      await toggleSignatureInFirestore(proposalId, currentUser, targetProposal.signatures);
    } catch (error) {
      console.error("Signature toggle error:", error);
      setDialog({ message: "署名の更新に失敗しました。", type: 'alert' });
    }
  };

  const handleAdminUpdate = async () => {
    if (!adminEditId) return;
    try {
      await updateProposalByAdmin(adminEditId, adminStatusSelect, adminResponseText);
      setAdminEditId(null);
      setDialog({ message: "生徒会公式回答とステータスを更新しました。", type: 'alert' });
    } catch (error) {
      console.error("Admin update error:", error);
      setDialog({ message: "更新に失敗しました。", type: 'alert' });
    }
  };

  const handleDeleteProposal = (proposalId: string) => {
    setDialog({
      title: "意見の削除確認",
      message: "この意見を完全に削除しますか？",
      type: 'confirm',
      onConfirm: async () => {
        try {
          await deleteProposalFromFirestore(proposalId);
          setSelectedProposalId(null);
          setAdminEditId(null);
        } catch (error) {
          console.error("Delete proposal error:", error);
        }
      }
    });
  };

  // --- Filtered Data ---
  const filteredProposals = useMemo(() => {
    const term = searchTerm.toLowerCase();
    return proposals.filter((p) => {
      const matchSearch = p.title.toLowerCase().includes(term) || p.content.toLowerCase().includes(term);
      const matchCategory = categoryFilter === 'all' || p.category === categoryFilter;
      return matchSearch && matchCategory;
    });
  }, [proposals, searchTerm, categoryFilter]);

  const pendingUsers = useMemo(() => {
    return allUsers.filter((u) => !u.isApproved && u.email !== ADMIN_EMAIL);
  }, [allUsers]);

  const selectedProposal = useMemo(() => {
    return proposals.find((p) => p.id === selectedProposalId);
  }, [proposals, selectedProposalId]);

  const filteredRules = useMemo(() => {
    if (!rulesSearch.trim()) return SCHOOL_RULES_SECTIONS;
    const query = rulesSearch.toLowerCase();
    return SCHOOL_RULES_SECTIONS.filter(
      r => r.title.toLowerCase().includes(query) ||
           r.summary.toLowerCase().includes(query) ||
           r.content.toLowerCase().includes(query)
    );
  }, [rulesSearch]);

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[260px_1fr] lg:grid-cols-[260px_1fr_320px] bg-bg-body dark:bg-bg-dark text-[#2d2d2d] dark:text-[#f0f0f0] transition-colors duration-300 font-sans">
      
      {/* Sidebar Navigation */}
      <aside className="bg-primary-dark text-white p-6 flex flex-col gap-6 h-screen sticky top-0 z-40 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent text-primary-dark flex items-center justify-center font-black text-xl shadow-lg">
            <span className="material-icons-round text-2xl">school</span>
          </div>
          <div>
            <h1 className="text-xl font-black tracking-tight leading-none">ProPoSal</h1>
            <span className="text-[10px] text-accent font-bold tracking-widest uppercase">デジタル目安箱</span>
          </div>
        </div>

        <nav className="flex flex-col gap-1.5 flex-1">
          <button 
            id="nav-home"
            onClick={() => setView('home')} 
            className={`flex items-center gap-3.5 px-4 py-3 rounded-xl font-bold transition-all text-sm ${view === 'home' ? 'bg-white/20 border-l-4 border-accent text-white shadow-sm' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
          >
            <span className="material-icons-round text-xl">home</span>Home
          </button>

          <button 
            id="nav-proposals"
            onClick={() => setView('proposals')} 
            className={`flex items-center gap-3.5 px-4 py-3 rounded-xl font-bold transition-all text-sm ${view === 'proposals' ? 'bg-white/20 border-l-4 border-accent text-white shadow-sm' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
          >
            <span className="material-icons-round text-xl">campaign</span>意見ボックス
            <span className="ml-auto text-xs bg-white/20 px-2 py-0.5 rounded-full font-black">{proposals.length}</span>
          </button>

          <button 
            id="nav-status"
            onClick={() => setView('status')} 
            className={`flex items-center gap-3.5 px-4 py-3 rounded-xl font-bold transition-all text-sm ${view === 'status' ? 'bg-white/20 border-l-4 border-accent text-white shadow-sm' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
          >
            <span className="material-icons-round text-xl">trending_up</span>進捗・ステータス
          </button>

          <button 
            id="nav-rules"
            onClick={() => setView('rules')} 
            className={`flex items-center gap-3.5 px-4 py-3 rounded-xl font-bold transition-all text-sm ${view === 'rules' ? 'bg-white/20 border-l-4 border-accent text-white shadow-sm' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
          >
            <span className="material-icons-round text-xl">menu_book</span>学校のきまり（校則）
          </button>

          {currentUser && (
            <button 
              id="nav-mypage"
              onClick={() => setView('mypage')} 
              className={`flex items-center gap-3.5 px-4 py-3 rounded-xl font-bold transition-all text-sm ${view === 'mypage' ? 'bg-white/20 border-l-4 border-accent text-white shadow-sm' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}
            >
              <span className="material-icons-round text-xl">person</span>マイページ
            </button>
          )}

          {currentUser?.role === 'admin' && (
            <button 
              id="nav-admin"
              onClick={() => setView('admin')} 
              className={`flex items-center gap-3.5 px-4 py-3 rounded-xl font-bold transition-all text-sm ${view === 'admin' ? 'bg-accent text-primary-dark shadow-md font-black' : 'text-accent hover:bg-white/10'}`}
            >
              <span className="material-icons-round text-xl">admin_panel_settings</span>生徒会管理
              {pendingUsers.length > 0 && (
                <span className="ml-auto bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black animate-pulse">
                  {pendingUsers.length}
                </span>
              )}
            </button>
          )}
        </nav>

        {/* Post Button */}
        <button 
          id="btn-open-post-modal"
          onClick={() => {
            if (!currentUser) {
              setDialog({ 
                title: "ログインが必要です", 
                message: "意見を投稿するには学校のGoogleアカウント（@toda-ed.jp）でログインしてください。", 
                type: 'alert' 
              });
              setView('login');
            } else {
              setIsPostModalOpen(true);
            }
          }} 
          className="bg-accent text-primary-dark font-black py-3.5 px-4 rounded-2xl shadow-xl hover:brightness-105 active:scale-95 transition-all flex items-center justify-center gap-2 text-sm"
        >
          <span className="material-icons-round text-lg">add_comment</span>
          <span>意見を投稿する</span>
        </button>

        {/* Auth User Info in Sidebar */}
        <div className="pt-4 border-t border-white/15">
          {currentUser ? (
            <div className="flex items-center gap-3">
              {currentUser.photoURL ? (
                <img src={currentUser.photoURL} alt={currentUser.name} className="w-10 h-10 rounded-full border-2 border-accent object-cover" />
              ) : (
                <div className="w-10 h-10 bg-white text-primary-dark rounded-full flex items-center justify-center font-black text-base shadow">
                  {currentUser.name.charAt(0)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-bold text-xs truncate leading-snug">{currentUser.name}</div>
                <div className="text-[10px] opacity-75 truncate flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${currentUser.role === 'admin' ? 'bg-accent' : currentUser.isApproved ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
                  {currentUser.role === 'admin' ? '生徒会管理者' : currentUser.isApproved ? '承認済' : '承認待ち'}
                </div>
              </div>
              <button 
                id="btn-logout"
                onClick={handleLogout} 
                title="ログアウト" 
                className="w-8 h-8 rounded-lg hover:bg-white/15 flex items-center justify-center transition-colors text-white/80 hover:text-white"
              >
                <span className="material-icons-round text-base">logout</span>
              </button>
            </div>
          ) : (
            <button 
              id="btn-sidebar-login"
              onClick={() => setView('login')} 
              className="w-full bg-white/15 hover:bg-white/25 py-2.5 rounded-xl border border-white/20 text-xs font-bold transition-all flex items-center justify-center gap-2"
            >
              <span className="material-icons-round text-sm">login</span>
              Googleログイン
            </button>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="bg-bg-body dark:bg-bg-dark overflow-y-auto min-h-screen">
        {/* Header */}
        <header className="px-8 py-5 flex justify-between items-center sticky top-0 bg-bg-body/85 dark:bg-bg-dark/85 backdrop-blur-md z-30 border-b border-gray-200/50 dark:border-gray-800/50">
          <div>
            <h2 className="text-2xl font-black capitalize tracking-tight text-gray-900 dark:text-white">
              {view === 'home' && 'Home - デジタル目安箱'}
              {view === 'proposals' && 'みんなの意見ボックス'}
              {view === 'status' && '進捗・検討ステータス'}
              {view === 'rules' && '戸田中学校 学校のきまり（校則）'}
              {view === 'mypage' && 'マイページ・アカウント設定'}
              {view === 'admin' && '生徒会管理者ダッシュボード'}
              {view === 'login' && 'Googleアカウント ログイン'}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">
              学校改善のための民主的プラットフォーム（@toda-ed.jp）
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button 
              id="btn-theme-toggle"
              onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')} 
              className="w-10 h-10 rounded-full bg-white dark:bg-bg-cardDark text-gray-800 dark:text-gray-200 shadow-sm border border-gray-200 dark:border-gray-700 flex items-center justify-center transition-transform hover:scale-105"
              title="テーマ切替"
            >
              <span className="material-icons-round text-lg">{theme === 'light' ? 'dark_mode' : 'light_mode'}</span>
            </button>
          </div>
        </header>

        <div className="p-8 max-w-5xl mx-auto">
          
          {/* VIEW: LOGIN */}
          {view === 'login' && (
            <div className="max-w-md mx-auto py-12 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="bg-white dark:bg-bg-cardDark rounded-[2.5rem] shadow-2xl p-8 border border-gray-100 dark:border-gray-800 text-center">
                <div className="w-16 h-16 rounded-3xl bg-primary/10 dark:bg-primary-light/20 text-primary dark:text-primary-light flex items-center justify-center mx-auto mb-6">
                  <span className="material-icons-round text-3xl">lock</span>
                </div>
                
                <h3 className="text-2xl font-black text-gray-900 dark:text-white mb-2">Googleアカウントでログイン</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-8 leading-relaxed">
                  学校指定のGoogleアカウント（<span className="font-bold text-primary dark:text-primary-light">@toda-ed.jp</span>）を使用してサインインしてください。
                </p>

                <div className="p-4 rounded-2xl bg-purple-50 dark:bg-purple-950/30 border border-purple-100 dark:border-purple-900/40 text-left mb-8 text-xs space-y-2 text-gray-700 dark:text-gray-300">
                  <div className="font-bold text-primary dark:text-primary-light flex items-center gap-1.5">
                    <span className="material-icons-round text-sm">info</span>
                    アカウント利用について
                  </div>
                  <p className="leading-relaxed">
                    ログイン後、生徒会による確認が完了すると意見への賛同（署名）が可能になります。意見の閲覧や新規投稿の作成はすぐにご利用いただけます。
                  </p>
                </div>

                <button 
                  id="btn-google-signin"
                  onClick={handleGoogleLogin} 
                  disabled={isLoggingIn}
                  className="w-full bg-white hover:bg-gray-50 text-gray-800 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-white border-2 border-gray-200 dark:border-gray-600 font-black py-4 px-6 rounded-2xl shadow-lg hover:shadow-xl transition-all flex items-center justify-center gap-3 text-base disabled:opacity-50"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                  </svg>
                  <span>{isLoggingIn ? '認証処理中...' : 'Googleアカウントでログイン'}</span>
                </button>
              </div>

              <div className="text-center">
                <button onClick={() => setView('home')} className="text-sm font-bold text-gray-500 hover:text-primary dark:text-gray-400">
                  ← Homeに戻る
                </button>
              </div>
            </div>
          )}

          {/* VIEW: HOME */}
          {view === 'home' && (
            <div className="space-y-10 animate-in fade-in duration-500">
              {/* Hero Banner */}
              <div className="p-10 md:p-12 rounded-[2.5rem] bg-gradient-to-br from-primary via-primary-dark to-primary-light text-white shadow-2xl relative overflow-hidden text-center">
                <div className="relative z-10 max-w-2xl mx-auto space-y-4">
                  <h3 className="text-4xl md:text-5xl font-black leading-tight tracking-tight">
                    テクノロジーで、<br />学校は変えられる。
                  </h3>
                  <p className="opacity-90 text-base md:text-lg leading-relaxed font-medium">
                    ProPoSalは、生徒一人ひとりの声を可視化し、<br className="hidden sm:inline" />
                    生徒会と先生が連携して民主的な学校改善を実現するプラットフォームです。
                  </p>
                  <div className="pt-4 flex flex-wrap justify-center gap-4">
                    <button 
                      onClick={() => setView('proposals')} 
                      className="bg-accent text-primary-dark font-black px-8 py-3.5 rounded-2xl shadow-xl hover:scale-105 transition-transform text-sm flex items-center gap-2"
                    >
                      <span className="material-icons-round text-lg">forum</span>
                      意見一覧を見る
                    </button>
                    {!currentUser && (
                      <button 
                        onClick={() => setView('login')} 
                        className="bg-white/20 hover:bg-white/30 backdrop-blur-md text-white font-bold px-8 py-3.5 rounded-2xl border border-white/30 transition-all text-sm flex items-center gap-2"
                      >
                        <span className="material-icons-round text-lg">login</span>
                        学校アカウントでログイン
                      </button>
                    )}
                  </div>
                </div>
                <span className="material-icons-round absolute -bottom-10 -right-10 text-[220px] opacity-10 pointer-events-none">auto_awesome</span>
              </div>

              {/* Rules & Guidelines */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-black text-gray-400 dark:text-purple-300 uppercase tracking-widest flex items-center gap-2">
                    <span className="material-icons-round text-sm">verified_user</span>
                    ProPoSalの仕組みと透明性ルール
                  </h4>
                </div>

                <div className="grid md:grid-cols-3 gap-6">
                  <div className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                      <span className="material-icons-round text-2xl">auto_fix_high</span>
                    </div>
                    <h5 className="font-black text-lg text-gray-900 dark:text-white">1. AIアドバイザーによる推敲</h5>
                    <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                      AIアドバイザーが事前に内容を添削し、建設的な提案にブラッシュアップします。
                    </p>
                  </div>

                  <div className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                      <span className="material-icons-round text-2xl">how_to_reg</span>
                    </div>
                    <h5 className="font-black text-lg text-gray-900 dark:text-white">2. 承認済み実名での署名</h5>
                    <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                      賛同・署名には「@toda-ed.jp」ログインと生徒会承認が必要です。いたずら投票を防ぎ、学校協議への確かな説得力を生み出します。
                    </p>
                  </div>

                  <div className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-green-50 dark:bg-green-950/40 text-green-600 dark:text-green-400 flex items-center justify-center">
                      <span className="material-icons-round text-2xl">sync_alt</span>
                    </div>
                    <h5 className="font-black text-lg text-gray-900 dark:text-white">3. 進捗・回答の可視化</h5>
                    <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                      ステータスは「受付中→検討中→先生と調整中→対応済」とリアルタイム更新され、生徒会からの公式回答が全員に共有されます。
                    </p>
                  </div>
                </div>
              </section>

              {/* School Rules Banner */}
              <section className="bg-gradient-to-r from-primary/10 via-primary-dark/10 to-accent/10 border border-primary/20 dark:border-primary-light/20 p-6 md:p-8 rounded-[2rem] flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-primary text-white flex items-center justify-center shrink-0 shadow-lg shadow-primary/20">
                    <span className="material-icons-round text-3xl">menu_book</span>
                  </div>
                  <div>
                    <h4 className="text-lg font-black text-gray-900 dark:text-white flex items-center gap-2">
                      戸田中学校「学校のきまり（校則）」を全編公開
                    </h4>
                    <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 leading-relaxed">
                      願・届、通学、服装、頭髪、持ち物、化粧・日傘、弁当・水筒、日常生活など全8章を閲覧・検索できます。
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setView('rules')}
                  className="bg-primary hover:bg-primary-dark text-white font-black px-6 py-3 rounded-xl text-xs shadow hover:scale-105 transition-all flex items-center gap-2 shrink-0"
                >
                  <span className="material-icons-round text-sm">visibility</span>
                  校則一覧を見る
                </button>
              </section>

              {/* Latest Proposals preview */}
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-black text-gray-400 dark:text-purple-300 uppercase tracking-widest flex items-center gap-2">
                    <span className="material-icons-round text-sm">campaign</span>
                    最新の意見
                  </h4>
                  <button onClick={() => setView('proposals')} className="text-xs font-black text-primary dark:text-primary-light hover:underline flex items-center gap-1">
                    全て見る ({proposals.length}) <span className="material-icons-round text-sm">chevron_right</span>
                  </button>
                </div>

                <div className="grid gap-4">
                  {proposals.slice(0, 3).map((p) => (
                    <div 
                      key={p.id}
                      onClick={() => setSelectedProposalId(p.id)}
                      className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm hover:shadow-lg transition-all border border-gray-100 dark:border-gray-800 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <StatusBadge status={p.status} />
                          <span className="text-xs font-bold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2.5 py-0.5 rounded-lg">
                            {p.category}
                          </span>
                        </div>
                        <h5 className="text-lg font-black text-gray-900 dark:text-white group-hover:text-primary dark:group-hover:text-primary-light transition-colors">
                          {p.title}
                        </h5>
                        <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
                          {p.content}
                        </p>
                      </div>

                      <div className="flex items-center gap-4 self-end sm:self-center">
                        <div className="flex items-center gap-1 text-pink-500 font-black text-sm bg-pink-50 dark:bg-pink-950/40 px-3 py-1.5 rounded-xl">
                          <span className="material-icons-round text-base">thumb_up</span>
                          <span>{p.signatures.length}</span>
                        </div>
                        <span className="material-icons-round text-gray-300 group-hover:text-primary transition-colors">arrow_forward_ios</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* VIEW: PROPOSALS */}
          {view === 'proposals' && (
            <div className="space-y-6 animate-in fade-in duration-500">
              <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                <div>
                  <h3 className="text-2xl font-black text-gray-900 dark:text-white">意見ボックス</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">全校生徒から集まった提案一覧（{filteredProposals.length}件）</p>
                </div>
                <button 
                  onClick={() => {
                    if (!currentUser) {
                      setDialog({ message: "投稿にはログインが必要です。", type: 'alert' });
                      setView('login');
                    } else {
                      setIsPostModalOpen(true);
                    }
                  }}
                  className="bg-primary dark:bg-primary-light text-white dark:text-primary-dark font-black px-6 py-3 rounded-xl text-xs shadow-lg hover:scale-105 transition-transform flex items-center gap-2"
                >
                  <span className="material-icons-round text-sm">add</span>
                  新しい意見を投稿
                </button>
              </div>

              {proposalsLoading ? (
                <div className="text-center py-20 text-gray-400 font-bold">読み込み中...</div>
              ) : filteredProposals.length === 0 ? (
                <div className="text-center py-20 bg-white dark:bg-bg-cardDark rounded-3xl border border-gray-100 dark:border-gray-800 text-gray-400 font-bold">
                  条件に一致する意見はありません
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredProposals.map((p) => (
                    <div 
                      key={p.id}
                      onClick={() => setSelectedProposalId(p.id)}
                      className="bg-white dark:bg-bg-cardDark p-8 rounded-[2rem] shadow-sm hover:shadow-xl cursor-pointer transition-all border border-gray-100 dark:border-gray-800 group"
                    >
                      <div className="flex justify-between items-center mb-4">
                        <div className="flex items-center gap-3">
                          <StatusBadge status={p.status} />
                          <span className="text-xs font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-lg">
                            {p.category}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-pink-500 font-black bg-pink-50 dark:bg-pink-950/40 px-3.5 py-1.5 rounded-xl text-sm">
                          <span className="material-icons-round text-base">thumb_up</span>
                          <span>{p.signatures.length} 署名</span>
                        </div>
                      </div>

                      <h4 className="text-2xl font-black mb-3 text-gray-900 dark:text-white group-hover:text-primary dark:group-hover:text-primary-light transition-colors">
                        {p.title}
                      </h4>
                      <p className="text-gray-600 dark:text-gray-300 line-clamp-2 leading-relaxed text-sm">
                        {p.content}
                      </p>

                      {p.adminResponse && (
                        <div className="mt-4 p-4 rounded-xl bg-purple-50 dark:bg-purple-950/20 border border-purple-100 dark:border-purple-900/30 text-xs text-primary dark:text-primary-light font-medium flex items-center gap-2">
                          <span className="material-icons-round text-sm">forum</span>
                          <span className="font-bold">生徒会回答あり:</span>
                          <span className="truncate text-gray-700 dark:text-gray-300">{p.adminResponse}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* VIEW: STATUS */}
          {view === 'status' && (
            <div className="space-y-6 animate-in fade-in duration-500">
              <div>
                <h3 className="text-2xl font-black text-gray-900 dark:text-white">進捗・ステータスボード</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">受付から対応完了までの進行状況</p>
              </div>

              <div className="grid lg:grid-cols-4 gap-4 items-start min-h-[60vh]">
                {STATUS_STEPS.map((step) => {
                  const stepProposals = proposals.filter((p) => p.status === step);
                  return (
                    <div key={step} className="bg-gray-100 dark:bg-gray-800/40 border border-gray-200/40 dark:border-gray-800 p-5 rounded-3xl flex flex-col gap-4 min-h-[400px]">
                      <div className="flex justify-between items-center px-1">
                        <StatusBadge status={step} />
                        <span className="text-xs font-black text-gray-400 dark:text-gray-400">{stepProposals.length}件</span>
                      </div>
                      <div className="space-y-3">
                        {stepProposals.map((p) => (
                          <div 
                            key={p.id}
                            onClick={() => setSelectedProposalId(p.id)}
                            className="bg-white dark:bg-bg-cardDark p-4 rounded-2xl shadow-sm cursor-pointer hover:border-primary dark:hover:border-primary-light text-gray-800 dark:text-gray-200 hover:text-primary dark:hover:text-primary-light border-2 border-transparent transition-all space-y-2 group"
                          >
                            <div className="font-bold text-sm leading-snug">{p.title}</div>
                            <div className="flex justify-between items-center text-[10px] text-gray-400">
                              <span>{p.category}</span>
                              <span className="text-pink-500 font-bold flex items-center gap-0.5">
                                <span className="material-icons-round text-xs">thumb_up</span>
                                {p.signatures.length}
                              </span>
                            </div>
                          </div>
                        ))}
                        {stepProposals.length === 0 && (
                          <div className="text-center py-12 text-xs font-bold text-gray-400">意見なし</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* VIEW: SCHOOL RULES */}
          {view === 'rules' && (
            <div className="space-y-6 animate-in fade-in duration-500">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-2xl font-black text-gray-900 dark:text-white flex items-center gap-2">
                    <span className="material-icons-round text-primary dark:text-primary-light">menu_book</span>
                    戸田中学校 学校のきまり（校則）
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    全8章の公式校則データです。校則の改善提案を行う際の条文確認や根拠づくりにご活用ください。
                  </p>
                </div>
                <div className="relative min-w-[260px]">
                  <input
                    type="text"
                    placeholder="校則内を検索（靴下、水筒、頭髪...）"
                    value={rulesSearch}
                    onChange={(e) => setRulesSearch(e.target.value)}
                    className="w-full bg-white dark:bg-bg-cardDark text-gray-900 dark:text-white dark:placeholder-gray-500 pl-9 pr-4 py-2.5 rounded-2xl text-xs outline-none focus:ring-2 ring-primary/20 border border-gray-200 dark:border-gray-700 shadow-sm"
                  />
                  <span className="material-icons-round text-gray-400 absolute left-3 top-2.5 text-sm">search</span>
                </div>
              </div>

              {/* Rules Category Quick Cards / Accordion */}
              <div className="space-y-4">
                {filteredRules.map((section) => (
                  <div 
                    key={section.id}
                    className="bg-white dark:bg-bg-cardDark rounded-3xl border border-gray-100 dark:border-gray-800 shadow-sm overflow-hidden transition-all hover:border-primary/30"
                  >
                    <div 
                      onClick={() => setExpandedRuleId(expandedRuleId === section.id ? null : section.id)}
                      className="p-6 flex items-center justify-between cursor-pointer select-none"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-2xl bg-primary/10 dark:bg-primary-light/10 text-primary dark:text-primary-light flex items-center justify-center font-black">
                          <span className="material-icons-round text-2xl">{section.icon}</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-black px-2 py-0.5 rounded-md bg-primary text-white">
                              第{section.number}章
                            </span>
                            <h4 className="text-lg font-black text-gray-900 dark:text-white">
                              {section.title}
                            </h4>
                          </div>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            {section.summary}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span 
                          className="material-icons-round text-gray-400 transition-transform duration-200"
                          style={{ transform: expandedRuleId === section.id ? 'rotate(180deg)' : 'none' }}
                        >
                          expand_more
                        </span>
                      </div>
                    </div>

                    {expandedRuleId === section.id && (
                      <div className="px-6 pb-6 pt-2 border-t border-gray-100 dark:border-gray-800/60 bg-gray-50/50 dark:bg-gray-900/20">
                        <div className="bg-white dark:bg-bg-cardDark p-5 rounded-2xl border border-gray-200/60 dark:border-gray-700/60 text-xs leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-line font-mono font-medium">
                          {section.content}
                        </div>
                        <div className="mt-4 flex justify-end">
                          <button
                            onClick={() => {
                              if (!currentUser) {
                                setDialog({
                                  title: "ログインが必要です",
                                  message: "意見を投稿するには学校のGoogleアカウント（@toda-ed.jp）でログインしてください。",
                                  type: 'alert'
                                });
                                setView('login');
                                return;
                              }
                              setPostForm({
                                title: `【第${section.number}章 ${section.title}】についての改善提案`,
                                content: `【対象のきまり】第${section.number}章 ${section.title}\n\n【現状の課題・見直したい理由】\n\n【具体的な改善案】\n`
                              });
                              setIsAIApproved(false);
                              setAiResult({ loading: false, result: null });
                              setIsPostModalOpen(true);
                            }}
                            className="bg-accent text-primary-dark font-black text-xs px-4 py-2 rounded-xl shadow hover:brightness-105 transition-all flex items-center gap-1.5"
                          >
                            <span className="material-icons-round text-sm">add_comment</span>
                            この章の校則について提案する
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {filteredRules.length === 0 && (
                  <div className="bg-white dark:bg-bg-cardDark p-12 rounded-3xl border border-gray-100 dark:border-gray-800 text-center text-xs text-gray-400">
                    検索条件に一致する校則項目が見つかりませんでした。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VIEW: MY PAGE */}
          {view === 'mypage' && currentUser && (
            <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-500">
              <div className="bg-white dark:bg-bg-cardDark p-8 md:p-10 rounded-[3rem] shadow-sm border border-gray-100 dark:border-gray-800 space-y-8">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-2xl font-black text-gray-900 dark:text-white">アカウント情報</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">学校アカウント（@toda-ed.jp）連携中</p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-black uppercase ${currentUser.role === 'admin' ? 'bg-accent text-primary-dark' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}>
                    {currentUser.role === 'admin' ? '生徒会管理者' : currentUser.role === 'teacher' ? '教職員' : '生徒'}
                  </span>
                </div>

                <div className="flex items-center gap-6 pb-6 border-b border-gray-100 dark:border-gray-800">
                  {currentUser.photoURL ? (
                    <img src={currentUser.photoURL} alt={currentUser.name} className="w-20 h-20 rounded-full border-4 border-primary/20 shadow-md object-cover" />
                  ) : (
                    <div className="w-20 h-20 bg-primary/10 text-primary dark:text-primary-light rounded-full flex items-center justify-center text-3xl font-black shadow-inner">
                      {currentUser.name.charAt(0)}
                    </div>
                  )}
                  <div className="space-y-1 flex-1">
                    <h4 className="text-2xl font-black text-gray-900 dark:text-white">{currentUser.name}</h4>
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{currentUser.email}</p>
                    <p className="text-xs font-bold text-primary dark:text-primary-light">
                      学年・クラス: {currentUser.class || '未設定'}
                    </p>
                  </div>
                  <button 
                    onClick={() => setIsEditingClass(!isEditingClass)}
                    className="text-xs font-bold bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 px-4 py-2 rounded-xl transition-colors"
                  >
                    {isEditingClass ? '閉じる' : '学年・クラス設定'}
                  </button>
                </div>

                {isEditingClass && (
                  <div className="p-6 rounded-2xl bg-gray-50 dark:bg-gray-800/60 space-y-4 border border-gray-200/60 dark:border-gray-700">
                    <div>
                      <h5 className="font-bold text-sm text-gray-900 dark:text-white">学年・クラスの設定</h5>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                        実名署名の公平性と信頼性を保つため、表示名（実名）はGoogleアカウントに紐づき固定されています。所属の学年・クラスのみ設定・更新できます。
                      </p>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-[10px] font-bold text-gray-400 uppercase">表示名（実名・変更不可）</label>
                        <div className="w-full bg-gray-100 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 p-3 rounded-xl text-xs text-gray-700 dark:text-gray-300 font-bold flex items-center justify-between mt-1">
                          <span>{currentUser.name}</span>
                          <span className="text-[10px] text-gray-400 font-medium flex items-center gap-1">
                            <span className="material-icons-round text-xs">lock</span>
                            実名固定
                          </span>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-gray-400 uppercase">学年・クラス</label>
                        <input 
                          type="text" 
                          className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-3 rounded-xl text-xs outline-none text-gray-900 dark:text-white mt-1 focus:border-primary" 
                          value={myClassInput} 
                          onChange={e => setMyClassInput(e.target.value)} 
                          placeholder="例: 2年3組"
                        />
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button 
                        onClick={handleSaveProfile}
                        className="bg-primary dark:bg-primary-light text-white dark:text-primary-dark font-black px-6 py-2.5 rounded-xl text-xs shadow hover:opacity-90 transition-all"
                      >
                        学年・クラスを保存
                      </button>
                    </div>
                  </div>
                )}

                {/* Approval Status Card */}
                <div className={`p-6 rounded-[2rem] flex items-center gap-5 border-2 ${currentUser.isApproved ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900/40 text-green-800 dark:text-green-300' : 'bg-yellow-50 dark:bg-yellow-950/20 border-yellow-200 dark:border-yellow-900/40 text-yellow-800 dark:text-yellow-300'}`}>
                  <span className="material-icons-round text-4xl">
                    {currentUser.isApproved ? 'verified_user' : 'hourglass_empty'}
                  </span>
                  <div>
                    <div className="text-lg font-black">
                      {currentUser.isApproved ? '承認済みアカウント' : '生徒会による承認待ち'}
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
                      {currentUser.isApproved 
                        ? 'すべての機能（意見投稿・実名署名・閲覧）をご利用いただけます。' 
                        : 'いたずら防止のため、生徒会の承認完了後に実名署名機能が有効化されます。'}
                    </p>
                  </div>
                </div>

                <div className="pt-6 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center">
                  <button 
                    onClick={handleLogout}
                    className="text-xs font-bold text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white flex items-center gap-1.5"
                  >
                    <span className="material-icons-round text-sm">logout</span>
                    ログアウト
                  </button>
                  <button 
                    onClick={handleDeleteAccount}
                    className="text-xs font-bold text-red-500 hover:text-red-700 flex items-center gap-1.5"
                  >
                    <span className="material-icons-round text-sm">person_remove</span>
                    アカウント連携解除・削除
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* VIEW: ADMIN (13250076@toda-ed.jp) */}
          {view === 'admin' && currentUser?.role === 'admin' && (
            <div className="space-y-8 animate-in fade-in duration-500">
              {/* Metrics */}
              <div className="grid sm:grid-cols-3 gap-6">
                <div className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm flex items-center justify-between border border-gray-100 dark:border-gray-800">
                  <div>
                    <div className="text-[10px] font-black text-gray-400 uppercase">承認待ちアカウント</div>
                    <div className="text-3xl font-black text-gray-900 dark:text-white mt-1">{pendingUsers.length}</div>
                  </div>
                  <span className="material-icons-round text-4xl text-yellow-500/20">person_add</span>
                </div>

                <div className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm flex items-center justify-between border border-gray-100 dark:border-gray-800">
                  <div>
                    <div className="text-[10px] font-black text-gray-400 uppercase">登録ユーザー総数</div>
                    <div className="text-3xl font-black text-gray-900 dark:text-white mt-1">{allUsers.length}</div>
                  </div>
                  <span className="material-icons-round text-4xl text-primary/20">group</span>
                </div>

                <div className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm flex items-center justify-between border border-gray-100 dark:border-gray-800">
                  <div>
                    <div className="text-[10px] font-black text-gray-400 uppercase">全意見数</div>
                    <div className="text-3xl font-black text-gray-900 dark:text-white mt-1">{proposals.length}</div>
                  </div>
                  <span className="material-icons-round text-4xl text-purple-500/20">campaign</span>
                </div>
              </div>

              {/* Admin Tabs */}
              <div className="bg-gray-100 dark:bg-gray-800 p-1.5 rounded-2xl flex gap-2 w-fit">
                <button 
                  onClick={() => setAdminTab('dashboard')} 
                  className={`px-6 py-2.5 rounded-xl font-black text-xs transition-all ${adminTab === 'dashboard' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow' : 'text-gray-400'}`}
                >
                  意見管理
                </button>
                <button 
                  onClick={() => setAdminTab('approvals')} 
                  className={`px-6 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-2 ${adminTab === 'approvals' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow' : 'text-gray-400'}`}
                >
                  承認待ち
                  {pendingUsers.length > 0 && (
                    <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black">
                      {pendingUsers.length}
                    </span>
                  )}
                </button>
                <button 
                  onClick={() => setAdminTab('users')} 
                  className={`px-6 py-2.5 rounded-xl font-black text-xs transition-all ${adminTab === 'users' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow' : 'text-gray-400'}`}
                >
                  全ユーザー一覧
                </button>
              </div>

              {/* TAB 1: Proposal Management */}
              {adminTab === 'dashboard' && (
                <div className="bg-white dark:bg-bg-cardDark p-6 md:p-8 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-[10px] font-black text-gray-400 uppercase border-b border-gray-100 dark:border-gray-800">
                      <tr>
                        <th className="pb-4">タイトル</th>
                        <th className="pb-4">カテゴリ</th>
                        <th className="pb-4">投稿者（内部監査用）</th>
                        <th className="pb-4">状態</th>
                        <th className="pb-4">署名数</th>
                        <th className="pb-4 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {proposals.map((p) => (
                        <tr key={p.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                          <td className="py-4 font-bold text-gray-900 dark:text-white max-w-xs truncate">{p.title}</td>
                          <td className="py-4 text-gray-500">{p.category}</td>
                          <td className="py-4 text-gray-500 font-mono text-[11px]">{p.authorName || '匿名'} ({p.authorEmail || '未記録'})</td>
                          <td className="py-4"><StatusBadge status={p.status} /></td>
                          <td className="py-4 font-black text-pink-500">{p.signatures.length}</td>
                          <td className="py-4 text-right space-x-2">
                            <button 
                              onClick={() => {
                                setAdminEditId(p.id);
                                setAdminResponseText(p.adminResponse || '');
                                setAdminStatusSelect(p.status);
                              }} 
                              className="text-primary dark:text-primary-light font-black hover:underline"
                            >
                              回答・変更
                            </button>
                            <button 
                              onClick={() => handleDeleteProposal(p.id)} 
                              className="text-red-500 font-bold hover:underline"
                            >
                              削除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* TAB 2: Approvals */}
              {adminTab === 'approvals' && (
                <div className="space-y-4">
                  {pendingUsers.map((u) => (
                    <div key={u.uid} className="bg-white dark:bg-bg-cardDark p-6 rounded-[2rem] shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border border-gray-100 dark:border-gray-800">
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-primary/10 text-primary dark:text-primary-light rounded-full flex items-center justify-center font-black text-lg">
                          {u.name.charAt(0)}
                        </div>
                        <div>
                          <div className="font-black text-base text-gray-900 dark:text-white flex items-center gap-2">
                            {u.name}
                            <span className="text-xs font-bold text-gray-400">({u.class || 'クラス未登録'})</span>
                          </div>
                          <div className="text-xs text-gray-500 font-mono">{u.email}</div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <button 
                          onClick={() => handleRejectUser(u.uid)} 
                          className="bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400 px-5 py-2.5 rounded-xl text-xs font-black hover:bg-red-100 transition-colors"
                        >
                          拒否
                        </button>
                        <button 
                          onClick={() => handleApproveUser(u.uid)} 
                          className="bg-primary dark:bg-primary-light text-white dark:text-primary-dark px-6 py-2.5 rounded-xl text-xs font-black shadow hover:opacity-90 transition-opacity flex items-center gap-1.5"
                        >
                          <span className="material-icons-round text-sm">verified_user</span>
                          承認する
                        </button>
                      </div>
                    </div>
                  ))}

                  {pendingUsers.length === 0 && (
                    <div className="text-center py-20 bg-white dark:bg-bg-cardDark rounded-3xl border border-gray-100 dark:border-gray-800 text-gray-400 font-bold">
                      現在、承認待ちのアカウントはありません
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: All Users */}
              {adminTab === 'users' && (
                <div className="bg-white dark:bg-bg-cardDark p-6 md:p-8 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-[10px] font-black text-gray-400 uppercase border-b border-gray-100 dark:border-gray-800">
                      <tr>
                        <th className="pb-4">ユーザー名</th>
                        <th className="pb-4">メールアドレス</th>
                        <th className="pb-4">クラス</th>
                        <th className="pb-4">役職</th>
                        <th className="pb-4">承認状態</th>
                        <th className="pb-4 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                      {allUsers.map((u) => (
                        <tr key={u.uid} className="hover:bg-gray-50 dark:hover:bg-gray-800/40">
                          <td className="py-4 font-bold text-gray-900 dark:text-white">{u.name}</td>
                          <td className="py-4 font-mono text-[11px] text-gray-500">{u.email}</td>
                          <td className="py-4 text-gray-500">{u.class || '-'}</td>
                          <td className="py-4">
                            <select 
                              className="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-lg p-1.5 text-xs font-bold outline-none"
                              value={u.role}
                              onChange={(e) => handleChangeUserRole(u.uid, e.target.value as any)}
                              disabled={u.email === ADMIN_EMAIL}
                            >
                              <option value="student">生徒</option>
                              <option value="teacher">教職員</option>
                              <option value="admin">管理者</option>
                            </select>
                          </td>
                          <td className="py-4">
                            <span className={`px-2.5 py-1 rounded-full text-[10px] font-black ${u.isApproved ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200' : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200'}`}>
                              {u.isApproved ? '承認済' : '未承認'}
                            </span>
                          </td>
                          <td className="py-4 text-right">
                            {u.email !== ADMIN_EMAIL && (
                              <button 
                                onClick={() => handleRejectUser(u.uid)} 
                                className="text-red-500 hover:underline font-bold text-xs"
                              >
                                削除
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

        </div>
      </main>

      {/* Right Sidebar: Search & Filter */}
      <aside className="bg-bg-body dark:bg-bg-dark border-l border-gray-200/60 dark:border-gray-800 p-6 space-y-8 hidden lg:block overflow-y-auto">
        <div className="bg-white dark:bg-bg-cardDark p-5 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800 space-y-3">
          <div className="font-bold text-primary dark:text-primary-light flex items-center gap-2 text-xs uppercase tracking-wider">
            <span className="material-icons-round text-sm">search</span>
            キーワード検索
          </div>
          <input 
            type="text" 
            placeholder="校則、体育館、部活..." 
            className="w-full bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white dark:placeholder-gray-500 p-3 rounded-xl text-xs outline-none focus:ring-2 ring-primary/20 border border-gray-200/60 dark:border-gray-700" 
            value={searchTerm} 
            onChange={e => setSearchTerm(e.target.value)} 
          />
        </div>

        <div className="space-y-3">
          <h4 className="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-widest flex items-center gap-1.5">
            <span className="material-icons-round text-sm">folder</span>
            カテゴリー分類
          </h4>
          <div className="flex flex-wrap gap-2">
            <button 
              onClick={() => setCategoryFilter('all')} 
              className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all ${categoryFilter === 'all' ? 'bg-primary text-white shadow-md' : 'bg-white dark:bg-bg-cardDark border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:border-primary/40'}`}
            >
              すべて ({proposals.length})
            </button>
            {CATEGORIES.map(c => (
              <button 
                key={c} 
                onClick={() => setCategoryFilter(c)} 
                className={`px-3.5 py-2 rounded-xl text-xs font-black transition-all ${categoryFilter === c ? 'bg-primary text-white shadow-md' : 'bg-white dark:bg-bg-cardDark border border-gray-200 dark:border-gray-800 text-gray-700 dark:text-gray-300 hover:border-primary/40'}`}
              >
                {c} ({proposals.filter(p => p.category === c).length})
              </button>
            ))}
          </div>
        </div>

        {/* School Rule quick helper */}
        <div className="bg-white dark:bg-bg-cardDark p-5 rounded-3xl border border-gray-100 dark:border-gray-800 space-y-3 text-xs">
          <div className="font-bold text-gray-900 dark:text-white flex items-center gap-1.5">
            <span className="material-icons-round text-primary dark:text-primary-light text-sm">menu_book</span>
            学校のきまり（校則）
          </div>
          <p className="text-gray-500 dark:text-gray-400 text-[11px] leading-relaxed">
            戸田中学校の公式校則データ（全8章）を参考資料として収録。生徒のアイデアや現場の実情をもとに、Gemini AIが説得力ある提案書へと推敲します。
          </p>
          <button 
            onClick={() => setView('rules')}
            className="w-full py-2 bg-primary/10 hover:bg-primary/20 text-primary dark:text-primary-light font-bold text-xs rounded-xl transition-colors flex items-center justify-center gap-1.5"
          >
            <span className="material-icons-round text-sm">open_in_new</span>
            校則一覧を閲覧する
          </button>
        </div>
      </aside>

      {/* MODAL: Post Proposal */}
      {isPostModalOpen && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-bg-cardDark w-full max-w-2xl rounded-[3rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-gray-100 dark:border-gray-800 animate-in zoom-in-95 duration-200">
            <div className="p-8 bg-primary text-white flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-black">意見を投稿する</h2>
                <p className="text-xs text-white/80 mt-1">※AI事前チェックを経て目安箱に公開されます</p>
              </div>
              <button 
                onClick={() => setIsPostModalOpen(false)} 
                className="w-10 h-10 rounded-full hover:bg-white/20 flex items-center justify-center transition-colors text-white"
              >
                <span className="material-icons-round">close</span>
              </button>
            </div>

            <div className="p-8 flex-1 overflow-y-auto space-y-6">
              <div>
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">提案のタイトル</label>
                <input 
                  type="text" 
                  placeholder="例: 雨の日の靴下色の柔軟化について" 
                  className="w-full text-xl font-black bg-transparent text-gray-900 dark:text-white border-b-2 border-gray-200 dark:border-gray-700 py-3 outline-none focus:border-primary dark:focus:border-primary-light transition-colors" 
                  value={postForm.title} 
                  onChange={e => {
                    setPostForm({...postForm, title: e.target.value});
                    setIsAIApproved(false);
                  }} 
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">具体的な内容・改善理由</label>
                  <button
                    type="button"
                    onClick={() => setIsRulesModalOpen(true)}
                    className="text-xs text-primary dark:text-primary-light font-bold flex items-center gap-1 hover:underline"
                  >
                    <span className="material-icons-round text-sm">menu_book</span>
                    校則（学校のきまり）を確認する
                  </button>
                </div>
                <textarea 
                  placeholder="現状の課題と、どのように改善したいかの理由を詳しく記入してください..." 
                  className="w-full min-h-[160px] p-5 bg-gray-50 dark:bg-gray-800/80 text-gray-900 dark:text-white outline-none resize-none leading-relaxed rounded-2xl border border-gray-200 dark:border-gray-700 text-sm mt-1" 
                  value={postForm.content} 
                  onChange={e => {
                    setPostForm({...postForm, content: e.target.value});
                    setIsAIApproved(false);
                  }} 
                />
              </div>

              {/* AI Advisor Box */}
              <div className={`p-6 rounded-2xl border-2 transition-all ${
                isAIApproved 
                  ? 'bg-green-50 dark:bg-green-950/20 border-green-300 dark:border-green-800 text-green-900 dark:text-green-200' 
                  : aiResult.result && !aiResult.result.isAppropriate
                    ? 'bg-red-50 dark:bg-red-950/20 border-red-300 dark:border-red-800 text-red-900 dark:text-red-200'
                    : 'bg-primary/5 dark:bg-primary-light/5 text-gray-800 dark:text-gray-200 border-primary/20'
              }`}>
                <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
                  <h5 className={`font-black flex items-center gap-2 text-sm ${
                    isAIApproved 
                      ? 'text-green-700 dark:text-green-300' 
                      : aiResult.result && !aiResult.result.isAppropriate
                        ? 'text-red-700 dark:text-red-300'
                        : 'text-primary dark:text-primary-light'
                  }`}>
                    <span className="material-icons-round text-base">
                      {isAIApproved ? 'verified' : aiResult.result && !aiResult.result.isAppropriate ? 'report_problem' : 'psychology'}
                    </span>
                    AIアドバイザー事前チェック（必須）
                  </h5>
                  <button 
                    onClick={handleAIAnalyze} 
                    disabled={aiResult.loading || !postForm.title.trim() || !postForm.content.trim()} 
                    className="bg-primary dark:bg-primary-light text-white dark:text-primary-dark px-5 py-2 rounded-full text-xs font-black shadow disabled:opacity-40 hover:opacity-90 transition-all flex items-center gap-1.5"
                  >
                    {aiResult.loading ? (
                      <>
                        <span className="material-icons-round animate-spin text-sm">sync</span>
                        <span>チェック中...</span>
                      </>
                    ) : (
                      <>
                        <span className="material-icons-round text-sm">auto_fix_high</span>
                        <span>{isAIApproved ? '再チェック実行' : 'チェック＆推敲実行'}</span>
                      </>
                    )}
                  </button>
                </div>

                {!aiResult.result && !aiResult.loading && (
                  <p className="text-xs opacity-75 leading-relaxed">
                    公立中学校の生徒会目安箱として、①公序良俗、②中学生としての健全性を確認し、生徒のみなさんの困りごとやアイデアを先生方・生徒会に伝わる提案書形式へとAIが推敲します（ジャージ登校や防寒具・靴下など生活に即した改善提案は大歓迎です。誹謗中傷やテスト容易化・宿題削減等の要望は却下されます）。「チェック＆推敲実行」ボタンを押してください。
                  </p>
                )}

                {aiResult.result && (
                  <div className="text-xs leading-relaxed space-y-2 mt-2 pt-2 border-t border-current/10">
                    <div className="font-bold flex items-center gap-2">
                      <span className={`px-2.5 py-1 rounded-md text-[11px] font-black ${
                        aiResult.result.isAppropriate 
                          ? 'bg-green-200 dark:bg-green-800 text-green-900 dark:text-green-100' 
                          : 'bg-red-200 dark:bg-red-800 text-red-900 dark:text-red-100'
                      }`}>
                        {aiResult.result.isAppropriate ? '✓ 適切（投稿可能）' : '✕ 投稿できません'}
                      </span>
                      <span>判定カテゴリ: {aiResult.result.category}</span>
                    </div>
                    <p className="opacity-90 font-medium whitespace-pre-wrap">{aiResult.result.advice}</p>
                  </div>
                )}

                {isAIApproved && (
                  <div className="text-xs font-black text-green-700 dark:text-green-300 flex items-center gap-1.5 mt-3 pt-2 border-t border-green-200 dark:border-green-800">
                    <span className="material-icons-round text-sm">check_circle</span>
                    AI安全チェックを通過しました。下のボタンを押して目安箱に投稿できます。
                  </div>
                )}

                {aiResult.result && !aiResult.result.isAppropriate && (
                  <div className="text-xs font-bold text-red-600 dark:text-red-400 flex items-center gap-1.5 mt-3 pt-2 border-t border-red-200 dark:border-red-800">
                    <span className="material-icons-round text-sm">lock</span>
                    AIチェックが承認されるまで、意見を投稿することはできません。
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {!isAIApproved ? '※AI事前チェックが完了すると投稿ボタンが有効化されます' : '※準備完了'}
              </span>
              <div className="flex gap-3">
                <button 
                  onClick={() => setIsPostModalOpen(false)} 
                  className="px-6 py-3 rounded-xl text-xs font-bold text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                >
                  閉じる
                </button>
                {isAIApproved && (
                  <button 
                    onClick={handlePostSubmit} 
                    className="bg-primary dark:bg-primary-light text-white dark:text-primary-dark font-black px-10 py-3 rounded-xl shadow-xl text-sm hover:scale-105 transition-transform"
                  >
                    目安箱へ送信する
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Proposal Details & Voting */}
      {selectedProposal && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-bg-cardDark w-full max-w-3xl rounded-[3rem] shadow-2xl overflow-hidden border border-gray-100 dark:border-gray-800 animate-in zoom-in-95 duration-200">
            <div className="p-8 md:p-10 bg-primary text-white flex justify-between items-start">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selectedProposal.status} />
                  <span className="text-xs font-bold bg-white/20 px-3 py-0.5 rounded-lg text-white">
                    {selectedProposal.category}
                  </span>
                </div>
                <h3 className="text-2xl md:text-3xl font-black tracking-tight">{selectedProposal.title}</h3>
              </div>
              <button 
                onClick={() => setSelectedProposalId(null)} 
                className="w-10 h-10 rounded-full hover:bg-white/20 flex items-center justify-center transition-colors text-white"
              >
                <span className="material-icons-round text-xl">close</span>
              </button>
            </div>

            <div className="p-8 md:p-10 space-y-8 max-h-[70vh] overflow-y-auto">
              <Stepper currentStatus={selectedProposal.status} />

              <div className="space-y-2">
                <h5 className="text-[10px] font-black text-gray-400 uppercase tracking-widest">提案内容</h5>
                <p className="text-base md:text-lg text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
                  {selectedProposal.content}
                </p>
              </div>

              {selectedProposal.adminResponse && (
                <div className="bg-purple-50 dark:bg-purple-950/20 p-6 rounded-[2rem] border-l-8 border-primary dark:border-primary-light border border-transparent dark:border-purple-900/30 shadow-sm space-y-2">
                  <h5 className="font-black text-primary dark:text-primary-light flex items-center gap-2 text-sm">
                    <span className="material-icons-round">forum</span>
                    生徒会・学校からの公式回答
                  </h5>
                  <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {selectedProposal.adminResponse}
                  </p>
                </div>
              )}

              <div className="pt-6 border-t border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                  <div className="text-2xl font-black text-primary dark:text-primary-light flex items-center gap-2">
                    <span className="material-icons-round text-pink-500">thumb_up</span>
                    <span>{selectedProposal.signatures.length} 名が賛同中</span>
                  </div>
                  {selectedProposal.signatures.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 max-w-md">
                      {selectedProposal.signatures.map((s, idx) => (
                        <span key={idx} className="text-[10px] font-bold bg-primary/10 text-primary dark:bg-primary-dark/30 dark:text-primary-light px-2.5 py-1 rounded-full">
                          {s.userName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <button 
                  id="btn-toggle-signature"
                  onClick={() => handleToggleSignature(selectedProposal.id)} 
                  className={`px-8 py-3.5 rounded-2xl font-black text-sm shadow-xl transition-all ${
                    currentUser && selectedProposal.signatures.some(s => s.userId === currentUser.uid || s.userEmail === currentUser.email)
                      ? 'bg-pink-100 dark:bg-pink-950/40 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-800' 
                      : 'bg-primary dark:bg-primary-light text-white dark:text-primary-dark hover:scale-105'
                  }`}
                >
                  {currentUser && selectedProposal.signatures.some(s => s.userId === currentUser.uid || s.userEmail === currentUser.email) 
                    ? '✓ 署名（賛同）済み' 
                    : '実名で署名（賛同）する'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Admin Edit Proposal */}
      {adminEditId && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-bg-cardDark w-full max-w-lg rounded-[2.5rem] p-8 space-y-6 animate-in zoom-in-95 border border-gray-100 dark:border-gray-800">
            <h3 className="text-xl font-black flex items-center gap-2 text-gray-900 dark:text-white">
              <span className="material-icons-round text-primary dark:text-primary-light">edit_note</span>
              進捗・公式回答の編集
            </h3>

            <div>
              <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">ステータス変更</label>
              <div className="flex flex-wrap gap-2">
                {STATUS_STEPS.map(s => (
                  <button 
                    key={s} 
                    onClick={() => setAdminStatusSelect(s)} 
                    className={`px-4 py-2 rounded-xl text-xs font-bold border-2 transition-all ${adminStatusSelect === s ? 'bg-primary dark:bg-primary-light border-primary dark:border-primary-light text-white dark:text-primary-dark shadow' : 'bg-gray-50 dark:bg-gray-800 border-transparent text-gray-700 dark:text-gray-300'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">生徒会・学校からの公式回答</label>
              <textarea 
                className="w-full bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white p-4 rounded-xl text-xs h-36 outline-none focus:ring-2 ring-primary/20 border border-gray-200 dark:border-gray-700" 
                value={adminResponseText} 
                onChange={e => setAdminResponseText(e.target.value)} 
                placeholder="生徒総会での議論状況や先生方との調整結果などを入力してください..." 
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button 
                onClick={() => setAdminEditId(null)} 
                className="text-xs font-bold text-gray-500 hover:text-gray-800 px-4 py-2"
              >
                キャンセル
              </button>
              <button 
                onClick={handleAdminUpdate} 
                className="bg-primary dark:bg-primary-light text-white dark:text-primary-dark font-black px-6 py-2.5 rounded-xl text-xs shadow hover:scale-105 transition-transform"
              >
                変更を保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: School Rules Quick Viewer */}
      {isRulesModalOpen && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-bg-cardDark w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] border border-gray-100 dark:border-gray-800 animate-in zoom-in-95 duration-200">
            <div className="p-6 bg-primary text-white flex justify-between items-center">
              <div className="flex items-center gap-3">
                <span className="material-icons-round text-2xl">menu_book</span>
                <div>
                  <h3 className="text-xl font-black">学校のきまり（校則）閲覧</h3>
                  <p className="text-[11px] text-white/80">戸田中学校 公式校則データ</p>
                </div>
              </div>
              <button 
                onClick={() => setIsRulesModalOpen(false)} 
                className="w-9 h-9 rounded-full hover:bg-white/20 flex items-center justify-center transition-colors text-white"
              >
                <span className="material-icons-round">close</span>
              </button>
            </div>

            <div className="p-6 flex-1 overflow-y-auto space-y-4">
              <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/60 p-3 rounded-xl">
                校則のどの条文・ルールに対する見直し提案かを明確にすると、生徒会や教職員との協議がスムーズになります。
              </div>

              <div className="space-y-3">
                {SCHOOL_RULES_SECTIONS.map((section) => (
                  <details 
                    key={section.id} 
                    className="group bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-200/70 dark:border-gray-700/60 overflow-hidden"
                    open={section.id === 'rules-3'}
                  >
                    <summary className="p-4 font-bold text-sm text-gray-900 dark:text-white cursor-pointer select-none flex items-center justify-between list-none">
                      <span className="flex items-center gap-2">
                        <span className="text-[10px] font-black px-2 py-0.5 rounded bg-primary text-white">第{section.number}章</span>
                        {section.title}
                      </span>
                      <span className="material-icons-round text-gray-400 group-open:rotate-180 transition-transform">expand_more</span>
                    </summary>
                    <div className="px-4 pb-4 pt-1 text-xs text-gray-800 dark:text-gray-200 whitespace-pre-line font-mono font-medium bg-white dark:bg-bg-cardDark m-3 mt-0 p-4 rounded-xl border border-gray-200 dark:border-gray-700">
                      {section.content}
                    </div>
                  </details>
                ))}
              </div>
            </div>

            <div className="p-4 bg-gray-50 dark:bg-gray-800/40 border-t border-gray-100 dark:border-gray-800 flex justify-end">
              <button
                onClick={() => setIsRulesModalOpen(false)}
                className="px-6 py-2 rounded-xl text-xs font-black bg-primary text-white shadow hover:scale-105 transition-transform"
              >
                投稿画面に戻る
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DIALOG: Alert / Confirm */}
      {dialog && (
        <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-bg-cardDark w-full max-w-sm p-6 rounded-[2rem] shadow-2xl animate-in zoom-in-95 border border-gray-100 dark:border-gray-800 text-center space-y-4">
            {dialog.title && (
              <h4 className="text-lg font-black text-gray-900 dark:text-white">{dialog.title}</h4>
            )}
            <p className="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
              {dialog.message}
            </p>
            <div className="flex justify-center gap-3 pt-2">
              {dialog.type === 'confirm' && (
                <button 
                  onClick={() => setDialog(null)} 
                  className="px-5 py-2 rounded-xl text-xs font-bold bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 transition-colors"
                >
                  キャンセル
                </button>
              )}
              <button 
                onClick={() => {
                  if (dialog.onConfirm) dialog.onConfirm();
                  setDialog(null);
                }} 
                className="px-6 py-2 rounded-xl text-xs font-black bg-primary text-white shadow hover:scale-105 transition-transform"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default App;
