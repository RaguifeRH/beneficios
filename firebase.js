// ============================================================================
// firebase.js — inicialização compartilhada do Firebase
// Importado tanto pela área do Funcionário quanto pela área do RH.
// Usa os SDKs modulares via CDN (sem build/empacotamento — pronto p/ GitHub Pages).
// ============================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, orderBy, writeBatch, serverTimestamp, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// --- Configuração do projeto (chave pública do front-end; não é segredo) ------
const firebaseConfig = {
  apiKey: 'AIzaSyBgl6GSdC-BPGpMcdAUoWDMbNsM8qn5p1A',
  authDomain: 'beneficios-f89ea.firebaseapp.com',
  projectId: 'beneficios-f89ea',
  storageBucket: 'beneficios-f89ea.firebasestorage.app',
  messagingSenderId: '722178353043',
  appId: '1:722178353043:web:29db185d0e1c8dd0416a66'
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Reexporta as funções do Firestore/Auth para os outros módulos não precisarem
// importar direto do CDN (mantém os imports centralizados em um único lugar).

export {
  db, auth,
  collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, orderBy, writeBatch, serverTimestamp, arrayUnion,
  signInWithEmailAndPassword, signOut, onAuthStateChanged
};
