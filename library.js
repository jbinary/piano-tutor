// Stores opened scores and practice position in IndexedDB so pieces survive reloads.

const DB_NAME = 'piano-tutor';

let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('scores', { keyPath: 'id', autoIncrement: true });
      req.result.createObjectStore('progress', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const tx = (await db()).transaction(store, mode);
  const req = fn(tx.objectStore(store));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** @returns {Promise<{id:number,name:string,addedAt:number}[]>} newest first, without file data */
export async function listScores() {
  const all = await run('scores', 'readonly', (s) => s.getAll());
  return all
    .map(({ id, name, addedAt }) => ({ id, name, addedAt }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

export const addScore = (name, data) =>
  run('scores', 'readwrite', (s) => s.add({ name, data, addedAt: Date.now() }));

export const getScore = (id) => run('scores', 'readonly', (s) => s.get(id));

export async function deleteScore(id) {
  await run('scores', 'readwrite', (s) => s.delete(id));
  await run('progress', 'readwrite', (s) => s.delete(id));
}

export const getProgress = (id) => run('progress', 'readonly', (s) => s.get(id));

export const saveProgress = (id, progress) =>
  run('progress', 'readwrite', (s) => s.put({ ...progress, id }));
