import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot, 
  query, 
  orderBy,
  serverTimestamp 
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  hd: 'toda-ed.jp',
  prompt: 'select_account'
});

// Use specified firestoreDatabaseId if present
export const db = firebaseConfig.firestoreDatabaseId 
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

export const ADMIN_EMAIL = '13250076@toda-ed.jp';
export const ALLOWED_DOMAIN = '@toda-ed.jp';

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  photoURL?: string;
  role: 'student' | 'teacher' | 'admin';
  class?: string;
  isApproved: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface Signature {
  userId: string;
  userName: string;
  userEmail?: string;
  timestamp: string;
}

export interface Proposal {
  id: string;
  numericId?: number;
  title: string;
  content: string;
  category: '校則' | '設備・環境' | '授業' | 'その他';
  status: '受付中' | '検討中' | '先生と調整中' | '対応済';
  adminResponse: string;
  timestamp: string;
  signatures: Signature[];
  authorId?: string;
  authorName?: string;
  authorEmail?: string;
}

// Google Sign-In with Domain Validation and User Profile Sync
export const loginWithGoogle = async (): Promise<UserProfile> => {
  const result = await signInWithPopup(auth, googleProvider);
  const user = result.user;

  if (!user.email || !user.email.endsWith(ALLOWED_DOMAIN)) {
    await signOut(auth);
    throw new Error(`ログインできませんでした。「${ALLOWED_DOMAIN}」で終わる学校指定のGoogleアカウントのみご利用いただけます。（現在: ${user.email || '未設定'}）`);
  }

  const userDocRef = doc(db, 'users', user.uid);
  const userSnap = await getDoc(userDocRef);
  const isAdmin = user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();

  let profile: UserProfile;

  if (!userSnap.exists()) {
    profile = {
      uid: user.uid,
      name: user.displayName || user.email.split('@')[0],
      email: user.email,
      photoURL: user.photoURL || '',
      role: isAdmin ? 'admin' : 'student',
      class: '',
      isApproved: isAdmin ? true : false,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    await setDoc(userDocRef, profile);
  } else {
    const existing = userSnap.data() as UserProfile;
    profile = {
      ...existing,
      name: existing.name || user.displayName || user.email.split('@')[0],
      photoURL: user.photoURL || existing.photoURL || '',
      role: isAdmin ? 'admin' : existing.role || 'student',
      isApproved: isAdmin ? true : (existing.isApproved ?? false),
      lastLoginAt: new Date().toISOString(),
    };
    
    // Security: Only send role & isApproved if admin, preventing accidental privilege alteration
    const updatePayload: Record<string, any> = {
      name: profile.name,
      photoURL: profile.photoURL,
      lastLoginAt: profile.lastLoginAt,
    };
    if (isAdmin) {
      updatePayload.role = 'admin';
      updatePayload.isApproved = true;
    }
    await updateDoc(userDocRef, updatePayload);
  }

  return profile;
};

// Logout
export const logoutFromFirebase = async (): Promise<void> => {
  await signOut(auth);
};

// Fetch or listen to user profile
export const subscribeToUserProfile = (uid: string, callback: (profile: UserProfile | null) => void) => {
  const userDocRef = doc(db, 'users', uid);
  return onSnapshot(userDocRef, (snap) => {
    if (snap.exists()) {
      callback(snap.data() as UserProfile);
    } else {
      callback(null);
    }
  }, (error) => {
    console.warn("Notice: user profile listener:", error.message);
    callback(null);
  });
};

// Listen to all users (for admin)
export const subscribeToAllUsers = (callback: (users: UserProfile[]) => void) => {
  const usersRef = collection(db, 'users');
  return onSnapshot(usersRef, (snapshot) => {
    const users: UserProfile[] = [];
    snapshot.forEach((docSnap) => {
      users.push(docSnap.data() as UserProfile);
    });
    callback(users);
  }, (error) => {
    console.warn("Notice: all users listener:", error.message);
    callback([]);
  });
};


// Approve user (Admin)
export const approveUserInFirestore = async (uid: string): Promise<void> => {
  const userDocRef = doc(db, 'users', uid);
  await updateDoc(userDocRef, { isApproved: true });
};

// Reject / Delete user (Admin)
export const rejectUserInFirestore = async (uid: string): Promise<void> => {
  const userDocRef = doc(db, 'users', uid);
  await deleteDoc(userDocRef);
};

// Update user role or class (User / Admin)
export const updateUserProfileInFirestore = async (uid: string, updates: Partial<UserProfile>): Promise<void> => {
  const userDocRef = doc(db, 'users', uid);
  await updateDoc(userDocRef, updates);
};

// Proposals Subscription
export const subscribeToProposals = (callback: (proposals: Proposal[]) => void) => {
  const proposalsRef = collection(db, 'proposals');
  const q = query(proposalsRef, orderBy('timestamp', 'desc'));
  
  return onSnapshot(q, (snapshot) => {
    const list: Proposal[] = [];
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      list.push({
        id: docSnap.id,
        numericId: data.numericId || undefined,
        title: data.title || '',
        content: data.content || '',
        category: data.category || 'その他',
        status: data.status || '受付中',
        adminResponse: data.adminResponse || '',
        timestamp: data.timestamp || new Date().toISOString(),
        signatures: data.signatures || [],
        authorId: data.authorId,
        authorName: data.authorName,
        authorEmail: data.authorEmail,
      });
    });
    callback(list);
  }, (error) => {
    console.error("Error listening to proposals:", error);
  });
};

// Add proposal to Firestore
export const addProposalToFirestore = async (proposal: Omit<Proposal, 'id'>): Promise<string> => {
  const proposalsRef = collection(db, 'proposals');
  const docRef = await addDoc(proposalsRef, {
    ...proposal,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
};

// Toggle signature in Firestore
export const toggleSignatureInFirestore = async (
  proposalId: string, 
  user: UserProfile, 
  currentSignatures: Signature[]
): Promise<void> => {
  const proposalRef = doc(db, 'proposals', proposalId);
  const existingIndex = currentSignatures.findIndex((s) => s.userId === user.uid || s.userEmail === user.email);
  
  let newSignatures: Signature[];
  if (existingIndex >= 0) {
    newSignatures = currentSignatures.filter((_, idx) => idx !== existingIndex);
  } else {
    newSignatures = [
      ...currentSignatures,
      {
        userId: user.uid,
        userName: user.name,
        userEmail: user.email,
        timestamp: new Date().toISOString(),
      }
    ];
  }

  await updateDoc(proposalRef, {
    signatures: newSignatures
  });
};

// Update proposal status & admin response (Admin)
export const updateProposalByAdmin = async (
  proposalId: string, 
  status: Proposal['status'], 
  adminResponse: string
): Promise<void> => {
  const proposalRef = doc(db, 'proposals', proposalId);
  await updateDoc(proposalRef, {
    status,
    adminResponse,
  });
};

// Delete proposal (Admin / Author)
export const deleteProposalFromFirestore = async (proposalId: string): Promise<void> => {
  const proposalRef = doc(db, 'proposals', proposalId);
  await deleteDoc(proposalRef);
};

// Seed initial proposal if empty
export const seedInitialProposalsIfEmpty = async (user?: UserProfile | null) => {
  if (!auth.currentUser) return; // Do not attempt write when unauthenticated
  try {
    const proposalsRef = collection(db, 'proposals');
    const snap = await getDocs(proposalsRef);
    if (snap.empty) {
      await addDoc(proposalsRef, {
        title: '靴下の色を自由にしたい',
        content: '現在は白・黒・紺のみですが、グレーや落ち着いた色合いも許可してほしいです。気温や個人の体調、洗濯のローテーションにも合わせやすくなります。',
        category: '校則',
        status: '先生と調整中',
        adminResponse: '生徒総会での議題として取り上げ、現在生徒指導の先生方と具体的なカラーコードについて協議中です。',
        timestamp: new Date().toISOString(),
        signatures: [
          {
            userId: auth.currentUser.uid,
            userName: auth.currentUser.displayName || '生徒会長',
            userEmail: auth.currentUser.email || '13250076@toda-ed.jp',
            timestamp: new Date().toISOString()
          }
        ],
        authorId: auth.currentUser.uid,
        authorName: auth.currentUser.displayName || '生徒会',
        authorEmail: auth.currentUser.email || '13250076@toda-ed.jp',
        createdAt: serverTimestamp(),
      });
    }
  } catch (error) {
    console.warn("Notice: Initial seed skipped or not permitted:", error);
  }
};

