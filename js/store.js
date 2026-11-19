// Historial local (IndexedDB): documentos procesados y el PDF original para poder continuar.
const DB = "ocr-traduccion";
let dbp = null;

function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("docs", { keyPath: "id" });
      d.createObjectStore("files");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const saveDoc = doc => tx("docs", "readwrite", s => s.put(doc)).catch(() => {});
export const getDoc = id => tx("docs", "readonly", s => s.get(id));
export const saveFile = (id, bytes) => tx("files", "readwrite", s => s.put(bytes, id)).catch(() => {});
export const getFile = id => tx("files", "readonly", s => s.get(id));
export async function listDocs() {
  const all = await tx("docs", "readonly", s => s.getAll()).catch(() => []);
  return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function deleteDoc(id) {
  await tx("docs", "readwrite", s => s.delete(id));
  await tx("files", "readwrite", s => s.delete(id));
}

// Huella rápida del archivo para reconocer un PDF ya procesado.
export async function fingerprint(bytes, name) {
  const sample = bytes.length > 2_000_000 ? new Uint8Array([...bytes.subarray(0, 1_000_000), ...bytes.subarray(-1_000_000)]) : bytes;
  const h = await crypto.subtle.digest("SHA-256", sample);
  return [...new Uint8Array(h)].slice(0, 10).map(b => b.toString(16).padStart(2, "0")).join("") + "-" + bytes.length + "-" + name.length;
}
