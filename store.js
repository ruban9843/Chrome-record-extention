// store.js — remembers the folder you picked, so you only choose it once.
// A FileSystemDirectoryHandle can be saved in IndexedDB; the popup, options page and offscreen
// document all share the same extension origin, so they all see the same saved handle.
const DB_NAME = 'recorder-settings';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSaveDir() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const q = db.transaction(STORE).objectStore(STORE).get('saveDir');
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => reject(q.error);
  });
}

async function setSaveDir(handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, 'saveDir');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
