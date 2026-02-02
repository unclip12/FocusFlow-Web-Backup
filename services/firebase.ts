
import firebase from "firebase/compat/app";
import "firebase/compat/auth";
import "firebase/compat/firestore";
import "firebase/compat/storage";
import "firebase/compat/messaging";
import { StudyMaterial, MaterialChatMessage, DayPlan, MentorMessage, MentorMemory, UserProfile, KnowledgeBaseEntry, TimeLogEntry, AISettings, RevisionSettings, DailyTracker, AppSettings, FMGEEntry, StudyEntry } from "../types";
import { notifySyncStart, notifySyncEnd } from "./syncService";

// --- CONFIGURATION ---

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize Firebase (Compat)
// Check if already initialized to prevent hot-reload errors in development
const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);

export const auth = app.auth();
export const db = app.firestore();

// Enable Offline Persistence
if (!firebase.apps.length) { // Only try enabling persistence on first init
    db.enablePersistence({ synchronizeTabs: true })
    .catch((err) => {
        if (err.code == 'failed-precondition') {
            console.warn('Firestore Persistence: Multiple tabs open, persistence can only be enabled in one tab at a time.');
        } else if (err.code == 'unimplemented') {
            console.warn('Firestore Persistence: Current browser does not support all of the features required to enable persistence.');
        }
    });
}

export const storage = app.storage();

// Initialize Messaging safely
let messaging: firebase.messaging.Messaging | null = null;
try {
  const isSupported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "indexedDB" in window;

  if (isSupported) {
      messaging = firebase.messaging();
  }
} catch (err) {
  console.warn("Firebase Messaging not initialized (unsupported environment).");
}

export { messaging };

// --- Helper to clean undefined values for Firestore ---
export const cleanData = (obj: any): any => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (obj instanceof Date) return obj.toISOString();
  
  if (Array.isArray(obj)) {
    return obj.map(cleanData);
  }
  
  const newObj: any = {};
  Object.keys(obj).forEach(key => {
    const value = obj[key];
    if (value !== undefined) {
      newObj[key] = cleanData(value);
    }
  });
  return newObj;
};

// Helper wrapper for sync notification
const withSync = async <T>(operation: () => Promise<T>): Promise<T> => {
    notifySyncStart();
    try {
        return await operation();
    } finally {
        notifySyncEnd();
    }
};

export const getUserProfile = async (): Promise<UserProfile | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('profile').doc('main');
        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                return docSnap.data() as UserProfile;
            }
        } catch (e) {
            console.warn("Network error fetching profile, returning null to prevent crash:", e);
        }
        return null;
    });
};

export const saveUserProfile = async (profile: UserProfile) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('profile').doc('main');
        await docRef.set(cleanData(profile), { merge: true });
    });
};


export const loginWithSecretId = async (secretId: string) => {
    const normalizedId = secretId.trim().toLowerCase();
    const email = `${normalizedId}@focusflow.app`;
    const password = `pass_${normalizedId}`;

    try {
        notifySyncStart();
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        notifySyncEnd();
        return userCredential.user;
    } catch (error: any) {
        if (error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
             try {
                 const newUser = await auth.createUserWithEmailAndPassword(email, password);
                 notifySyncEnd();
                 return newUser.user;
             } catch (createError) {
                 notifySyncEnd();
                 throw createError;
             }
        }
        notifySyncEnd();
        throw error;
    }
};

export const uploadFile = async (file: File): Promise<string> => {
    return withSync(async () => {
        if (!auth.currentUser) throw new Error("No user logged in");
        const safeName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
        const storageRef = storage.ref(`users/${auth.currentUser.uid}/attachments/${Date.now()}_${safeName}`);
        const snapshot = await storageRef.put(file);
        return await snapshot.ref.getDownloadURL();
    });
};

export const uploadTempFile = async (file: File): Promise<{ url: string, fullPath: string }> => {
    return withSync(async () => {
        if (!auth.currentUser) throw new Error("No user logged in");
        const safeName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
        const storageRef = storage.ref(`temp/${auth.currentUser.uid}/${Date.now()}_${safeName}`);
        const snapshot = await storageRef.put(file);
        const url = await snapshot.ref.getDownloadURL();
        return { url, fullPath: snapshot.ref.fullPath };
    });
};

export const deleteTempFile = async (fullPath: string) => {
    return withSync(async () => {
        const storageRef = storage.ref(fullPath);
        await storageRef.delete();
    });
};

export const saveStudyMaterial = async (material: StudyMaterial) => {
    return withSync(async () => {
        if (!auth.currentUser) throw new Error("No user logged in");
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('materials').doc(material.id);
        await docRef.set(cleanData(material));
    });
};

export const getStudyMaterials = async (): Promise<StudyMaterial[]> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('materials');
        try {
            const snap = await colRef.get();
            return snap.docs.map(d => d.data() as StudyMaterial).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        } catch (e) {
            console.warn("Failed to fetch study materials (offline?)", e);
            return [];
        }
    });
};

export const deleteStudyMaterial = async (materialId: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        await db.collection('users').doc(auth.currentUser.uid).collection('materials').doc(materialId).delete();
    });
};

export const toggleMaterialActive = async (materialId: string, isActive: boolean) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const materialsRef = db.collection('users').doc(auth.currentUser.uid).collection('materials');
        
        try {
            if (isActive) {
                const batch = db.batch();
                const activeSnap = await materialsRef.where('isActive', '==', true).get();
                activeSnap.forEach(doc => {
                    if (doc.id !== materialId) {
                        batch.update(doc.ref, { isActive: false });
                    }
                });
                await batch.commit();
            }
            await materialsRef.doc(materialId).update({ isActive });
        } catch (e) {
            console.error("Failed to toggle material active state", e);
        }
    });
};

export const updateMaterialTitle = async (materialId: string, newTitle: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        await db.collection('users').doc(auth.currentUser.uid).collection('materials').doc(materialId).update({ title: newTitle });
    });
};

export const saveMaterialChat = async (materialId: string, chat: MaterialChatMessage) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('materials').doc(materialId).collection('chats');
        await colRef.add(cleanData(chat));
    });
};

export const getMaterialChats = async (materialId: string): Promise<MaterialChatMessage[]> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('materials').doc(materialId).collection('chats');
        try {
            const snap = await colRef.orderBy('timestamp', 'asc').get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() } as MaterialChatMessage));
        } catch (e) {
            console.warn("Failed to load material chats", e);
            return [];
        }
    });
};

export const saveMentorMessage = async (message: MentorMessage) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('mentorMessages').doc(message.id);
        await docRef.set(cleanData(message));
    });
};

export const getMentorMessages = async (): Promise<MentorMessage[]> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('mentorMessages');
        try {
            const snap = await colRef.orderBy('timestamp', 'asc').get();
            return snap.docs.map(d => d.data() as MentorMessage);
        } catch (e) {
            console.warn("Failed to load mentor messages", e);
            return [];
        }
    });
};

export const clearMentorMessages = async () => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('mentorMessages');
        try {
            const snap = await colRef.get();
            const batch = db.batch();
            snap.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
        } catch (e) {
            console.error("Failed to clear mentor messages", e);
        }
    });
};

export const saveChatMaterial = async (text: string, filename: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const id = Date.now().toString();
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('materialsFromChat').doc(id);
        await docRef.set({
            text,
            originalFileName: filename,
            sourceType: 'CHAT_ATTACHMENT',
            createdAt: new Date().toISOString()
        });
        return id;
    });
};

export const getMentorMemoryData = async (): Promise<MentorMemory | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('aiMentorMemory').doc('profile');
        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                return docSnap.data() as MentorMemory;
            }
        } catch (e) {
            console.warn("Failed to fetch Mentor Memory", e);
        }
        return null;
    });
};

export const saveMentorMemoryData = async (memory: MentorMemory) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('aiMentorMemory').doc('profile');
        await docRef.set(cleanData({ ...memory, lastUpdated: new Date().toISOString() }), { merge: true });
    });
};

export const addToBacklog = async (item: any) => {
    const memory = await getMentorMemoryData();
    const currentBacklog = memory?.backlog || [];
    if (currentBacklog.find((b: any) => b.id === item.id)) return;
    const updatedBacklog = [...currentBacklog, item];
    await saveMentorMemoryData({ backlog: updatedBacklog });
}

// --- NEW AI & REVISION SETTINGS ---

export const getAISettings = async (): Promise<AISettings | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('config').doc('aiSettings');
        try {
            const docSnap = await docRef.get();
            return docSnap.exists ? docSnap.data() as AISettings : null;
        } catch (e) {
            console.warn("Failed to fetch AI Settings", e);
            return null;
        }
    });
};

export const saveAISettings = async (settings: AISettings) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('config').doc('aiSettings');
        await docRef.set(cleanData(settings), { merge: true });
    });
};

export const getRevisionSettings = async (): Promise<RevisionSettings | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('config').doc('revisionSettings');
        try {
            const docSnap = await docRef.get();
            return docSnap.exists ? docSnap.data() as RevisionSettings : null;
        } catch (e) {
            console.warn("Failed to fetch Revision Settings", e);
            return null;
        }
    });
};

export const saveRevisionSettings = async (settings: RevisionSettings) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('config').doc('revisionSettings');
        await docRef.set(cleanData(settings), { merge: true });
    });
};

// --- MAIN APP SETTINGS ---

export const getAppSettings = async (): Promise<AppSettings | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('config').doc('appSettings');
        try {
            const docSnap = await docRef.get();
            return docSnap.exists ? docSnap.data() as AppSettings : null;
        } catch (e) {
            console.warn("Failed to fetch App Settings", e);
            return null;
        }
    });
};

export const saveAppSettings = async (settings: AppSettings) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('config').doc('appSettings');
        await docRef.set(cleanData(settings), { merge: true });
    });
};

// --- DAY PLANS ---

export const saveDayPlan = async (plan: DayPlan) => {
    return withSync(async () => {
        if (!auth.currentUser) throw new Error("No user logged in");
        if (!plan.date || plan.date.length !== 10) throw new Error("Invalid date format. Must be YYYY-MM-DD.");
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('dayPlans').doc(plan.date);
        await docRef.set(cleanData(plan));
    });
};

export const getDayPlan = async (date: string): Promise<DayPlan | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('dayPlans').doc(date);
        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                return docSnap.data() as DayPlan;
            }
        } catch (e) {
            console.warn("Failed to fetch day plan (offline?)", e);
        }
        return null;
    });
};

export const deleteDayPlan = async (date: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('dayPlans').doc(date);
        await docRef.delete();
    });
};

// --- DAILY TRACKER ---
export const getDailyTracker = async (date: string): Promise<DailyTracker | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return null;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('dailyTrackers').doc(date);
        try {
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                return docSnap.data() as DailyTracker;
            }
        } catch (e) {
            console.warn("Failed to fetch Daily Tracker", e);
        }
        return null;
    });
};

export const saveDailyTracker = async (tracker: DailyTracker) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('dailyTrackers').doc(tracker.date);
        await docRef.set(cleanData(tracker), { merge: true });
    });
};


// --- KNOWLEDGE BASE (FA PAGES) ---
export const getKnowledgeBase = async (): Promise<KnowledgeBaseEntry[] | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('knowledgeBase');
        try {
            const snap = await colRef.get();
            return snap.docs.map(d => d.data() as KnowledgeBaseEntry);
        } catch (e) {
            console.warn("Failed to fetch Knowledge Base (offline?)", e);
            return null; 
        }
    });
};

export const saveKnowledgeBase = async (kb: KnowledgeBaseEntry[]) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const chunkArray = <T>(array: T[], size: number): T[][] => {
            const chunked: T[][] = [];
            for (let i = 0; i < array.length; i += size) {
                chunked.push(array.slice(i, i + size));
            }
            return chunked;
        };
        const chunks = chunkArray(kb, 450);
        for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(entry => {
                const docRef = db.collection('users').doc(auth.currentUser!.uid).collection('knowledgeBase').doc(entry.pageNumber);
                batch.set(docRef, cleanData(entry));
            });
            await batch.commit();
        }
    });
};

export const deleteKnowledgeBaseEntry = async (pageNumber: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('knowledgeBase').doc(pageNumber);
        await docRef.delete();
    });
};

// --- TIME LOGGER ---

export const saveTimeLog = async (entry: TimeLogEntry) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('timeLogs').doc(entry.id);
        await docRef.set(cleanData(entry));
    });
};

export const getTimeLogs = async (date: string): Promise<TimeLogEntry[]> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('timeLogs');
        try {
            const snap = await colRef.where('date', '==', date).get();
            return snap.docs.map(d => d.data() as TimeLogEntry).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
        } catch (e) {
            console.warn("Failed to fetch time logs", e);
            return [];
        }
    });
};

export const deleteTimeLog = async (id: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('timeLogs').doc(id);
        await docRef.delete();
    });
};

// --- FMGE DATA ---

export const getFMGEData = async (): Promise<FMGEEntry[] | null> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('fmgeData');
        try {
            const snap = await colRef.get();
            return snap.docs.map(d => d.data() as FMGEEntry);
        } catch (e) {
            console.warn("Failed to fetch FMGE Data (offline?)", e);
            return null;
        }
    });
};

export const saveFMGEEntry = async (entry: FMGEEntry) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('fmgeData').doc(entry.id);
        await docRef.set(cleanData(entry));
    });
};

export const deleteFMGEEntry = async (id: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('fmgeData').doc(id);
        await docRef.delete();
    });
};

// --- STUDY TRACKER (Requested View) ---

export const getStudyEntries = async (date: string): Promise<StudyEntry[]> => {
    return withSync(async () => {
        if (!auth.currentUser) return [];
        const colRef = db.collection('users').doc(auth.currentUser.uid).collection('studyEntries');
        try {
            const snap = await colRef.where('date', '==', date).get();
            return snap.docs.map(d => d.data() as StudyEntry).sort((a, b) => a.time.localeCompare(b.time));
        } catch (e) {
            console.warn("Failed to fetch study entries", e);
            return [];
        }
    });
};

export const saveStudyEntry = async (entry: StudyEntry) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('studyEntries').doc(entry.id);
        await docRef.set(cleanData(entry));
    });
};

export const deleteStudyEntry = async (id: string) => {
    return withSync(async () => {
        if (!auth.currentUser) return;
        const docRef = db.collection('users').doc(auth.currentUser.uid).collection('studyEntries').doc(id);
        await docRef.delete();
    });
};
