const databaseName = 'personal-knowledge-web.records.v1';
const storeName = 'records';
const limits = { title: 300, material: 80000, source: 2000, analysis: 48000, notes: 16000 };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本机记录。请检查浏览器的站点存储权限。'));
  });
}

async function transact(mode, run) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || new Error('本机存储操作失败。请检查浏览器空间和站点权限。'));
      run(tx.objectStore(storeName), value => { result = value; }, message => {
        failure = new Error(message);
        tx.abort();
      });
    });
  } finally {
    db.close();
  }
}

export async function putRecord(input) {
  const fields = {};
  for (const [field, limit] of Object.entries(limits)) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw new Error('记录内容过长或格式不正确。');
    fields[field] = value.trim();
  }
  if (!fields.title) throw new Error('请给记录起个标题。');
  if (!fields.material && !fields.analysis && !fields.notes) throw new Error('请填写要保留的材料、解读或备注。');
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id)) throw new Error('无法识别这条记录。');
  const record = { ...fields, id: input.id ?? crypto.randomUUID(), updatedAt: new Date().toISOString(), verification: 'not_checked' };
  return transact('readwrite', (store, done, fail) => {
    if (!input.id) {
      store.add(record);
      done(record);
      return;
    }
    const read = store.get(input.id);
    read.onsuccess = () => {
      if (!read.result) return fail('这条记录已被删除。请返回记录列表。');
      if (read.result.updatedAt !== input.updatedAt) return fail('这条记录刚在其他页面更新，请重新打开。');
      record.updatedAt = new Date(Math.max(Date.now(), Date.parse(read.result.updatedAt) + 1)).toISOString();
      store.put(record);
      done(record);
    };
  });
}

export async function listRecords(query = '') {
  const records = await transact('readonly', (store, done) => {
    const read = store.getAll();
    read.onsuccess = () => done(read.result);
  });
  const fold = value => value.normalize('NFKC').toLowerCase();
  const keyword = fold(query.trim());
  return records.filter(record => !keyword || Object.keys(limits).some(field => fold(record[field]).includes(keyword)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteRecord(id, updatedAt) {
  return transact('readwrite', (store, done, fail) => {
    const read = store.get(id);
    read.onsuccess = () => {
      if (!read.result) return;
      if (read.result.updatedAt !== updatedAt) return fail('这条记录刚在其他页面更新，请重新打开后再删除。');
      store.delete(id);
    };
  });
}
