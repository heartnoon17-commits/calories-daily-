/**
 * firebase.js
 * - ตั้งค่า Firebase SDK (CDN) แบบ Modular v9+
 * - export ฟังก์ชันที่จำเป็นให้ app.js เรียกใช้
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/**
 * ✅ ใส่ Firebase Config ของคุณตรงนี้
 * ไปที่ Firebase Console → Project settings → Your apps → SDK setup and configuration
 */
const firebaseConfig = {
    apiKey: "AIzaSyBGn8D_bgTvR0lUgWQWIQsQkTEMs-7Em1Y",
    authDomain: "daily-calories-48330.firebaseapp.com",
    projectId: "daily-calories-48330",
    storageBucket: "daily-calories-48330.firebasestorage.app",
    messagingSenderId: "12644102638",
    appId: "1:12644102638:web:33a92023779b6bc7375eff",
    measurementId: "G-W3JMBHX1JR"
  };



// init
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// export Auth helpers
export const fb = {
  auth,
  db,
  // Auth
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  // Firestore
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp
};
