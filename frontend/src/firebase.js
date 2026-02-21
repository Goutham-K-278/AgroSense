import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getDatabase } from 'firebase/database'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: 'AIzaSyCZeYHYlKVXLiXnq9zmRWshq7MirnxzCB0',
  authDomain: 'uzhavar-ai-system.firebaseapp.com',
  databaseURL: 'https://uzhavar-ai-system-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'uzhavar-ai-system',
  storageBucket: 'uzhavar-ai-system.appspot.com',
  messagingSenderId: '870561825533',
  appId: '1:870561825533:web:52c0cf17b0c453e6067494',
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const provider = new GoogleAuthProvider()
provider.setCustomParameters({ prompt: 'select_account' })
export const db = getFirestore(app)
export const database = getDatabase(app)
export const storage = getStorage(app)
