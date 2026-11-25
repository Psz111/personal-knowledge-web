import { providers, streamReply } from './model.js';
import { listRecords, putRecord, deleteRecord } from './records.js';

const el = id => document.getElementById(id);
const chat = el('chat-view');
const library = el('records-view');
const question = el('question');
const messages = el('messages');
const thread = messages.parentElement;
const settings = el('settings-dialog');
const materialDialog = el('material-dialog');
const recordDialog = el('record-dialog');
const provider = el('provider');
const keyInput = el('api-key');
const consent = el('consent');
const recordFields = ['title', 'material', 'source', 'analysis', 'notes'];

let connection = null;
let material = { text: '', source: '' };
let turns = [];
let running = null;
let editing = null;
let writing = false;
let listRevision = 0;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function notice(text = '') {
  el('status').textContent = text;
}

function chatControls() {
  const busy = running !== null;
  el('send').hidden = busy;
  el('stop').hidden = !busy;
  el('send').disabled = !question.value.trim() && !material.text;
  el('save-discussion').disabled = busy || !(turns.length || material.text || question.value.trim());
  el('open-material').disabled = busy;
  el('open-settings').disabled = busy;
  el('model-button').disabled = busy;
  el('empty-state').hidden = turns.length > 0;
  el('material-summary').hidden = !material.text;
  el('material-summary').textContent = material.text ? '已附材料 · ' + material.text.slice(0, 50) : '';
  el('model-label').textContent = connection?.model || '配置模型';
}

function setView(showRecords) {
  chat.hidden = showRecords;
  library.hidden = !showRecords;
  el('page-title').textContent = showRecords ? '我的记录' : '当前对话';
  el('open-records').setAttribute('aria-pressed', String(showRecords));
  notice();
  if (showRecords) {
    refreshRecords();
    el('search').focus();
  }
}

function openSettings() {
  if (running) return;
  provider.value = connection?.provider || 'deepseek';
  el('model').value = connection?.model || providers[provider.value].model;
  keyInput.value = '';
  consent.checked = Boolean(connection);
  el('settings-status').textContent = '';
  updateRecipient();
  settings.showModal();
}

function updateRecipient() {
  el('endpoint').textContent = providers[provider.value].endpoint;
  keyInput.placeholder = connection?.provider === provider.value ? '已在本页配置，留空可继续使用' : '输入自己的 API Key';
  el('disconnect').hidden = !connection;
}

function applySettings() {
  const recipient = provider.value;
  const model = el('model').value.trim();
  const key = keyInput.value.trim() || (connection?.provider === recipient ? connection.key : '');
  let issue = '';
  if (!key || /\s/.test(key)) issue = '请填写这个服务商的有效 API Key。';
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(model)) issue = '请填写服务商提供的模型 ID，最多 100 个字符。';
  else if (!consent.checked) issue = '请确认本次聊天使用的接收方和发送范围。';
  if (issue) {
    el('settings-status').textContent = issue;
    return;
  }
  connection = { provider: recipient, model, key };
  settings.close();
  chatControls();
  notice('已配置 ' + providers[recipient].label + '。');
  if (!chat.hidden) question.focus();
}

function openMaterial() {
  el('material').value = material.text;
  el('source').value = material.source;
  // Each conversation discusses one material. Changing it after a message
  // was sent would incorrectly associate that earlier answer with new text.
  el('material').readOnly = turns.length > 0;
  el('material-status').textContent = turns.length ? '这段对话使用当前材料。换一份材料时，请新建对话。' : '';
  materialDialog.showModal();
}

function applyMaterial() {
  const text = el('material').value.trim();
  const source = el('source').value.trim();
  if (text.length > 80000 || source.length > 2000) {
    el('material-status').textContent = '材料最多 80000 字，来源最多 2000 字。';
    return;
  }
  if (source && !text && !turns.length) {
    el('material-status').textContent = '请先填入这次要讨论的材料。';
    return;
  }
  material = { text, source };
  materialDialog.close();
  chatControls();
  question.focus();
}

function newChat() {
  if ((turns.length || material.text || question.value.trim()) &&
      !window.confirm('开始新对话会清空这段临时讨论。继续吗？')) return;
  const previous = running;
  running = null;
  previous?.abort();
  turns = [];
  material = { text: '', source: '' };
  question.value = '';
  messages.replaceChildren();
  setView(false);
  chatControls();
  question.focus();
}

function appendMessage(role, label, value = '') {
  const article = node('article', 'message message-' + role);
  article.append(node('div', 'message-author', label));
  const body = node('p', 'message-text', value);
  article.append(body);
  messages.append(article);
  return { article, body };
}

function scrollToMessage(element) {
  if (!chat.hidden) element.scrollIntoView({ block: 'nearest' });
}

async function send(event) {
  event.preventDefault();
  if (running) return;
  const text = question.value.trim() || (material.text ? '你怎么看这份材料？' : '');
  if (!text) return;
  if (!connection) {
    openSettings();
    el('settings-status').textContent = '先选择模型服务并填写自己的 Key，刚输入的内容会保留。';
    return;
  }
  const history = turns.filter(turn => turn.complete).flatMap(turn => [
    { role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer },
  ]);
  const controller = new AbortController();
  running = controller;
  const turn = { question: text, answer: '', complete: false };
  turns.push(turn);
  question.value = '';
  notice();
  appendMessage('user', '你', text);
  const { article, body } = appendMessage('assistant', connection.model + ' · 未做外部核查');
  const hint = node('span', 'message-status', '正在连接…');
  hint.setAttribute('role', 'status');
  article.append(hint);
  const answerText = document.createTextNode('');
  body.append(answerText);
  let thoughtText;
  let following = true;
  let frame = 0;
  function trackScroll() {
    following = thread.scrollHeight - thread.clientHeight - thread.scrollTop < 70;
  }
  function followOutput() {
    if (!following || frame || chat.hidden) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (following && !chat.hidden) thread.scrollTop = thread.scrollHeight;
    });
  }
  thread.addEventListener('scroll', trackScroll, { passive: true });
  chatControls();
  scrollToMessage(hint);
  try {
    await streamReply({
      ...connection, material: material.text, question: text, history, signal: controller.signal,
      onText(delta) {
        if (running !== controller) return;
        hint.textContent = '';
        turn.answer += delta;
        answerText.appendData(delta);
        followOutput();
      },
      onThinking(delta) {
        if (running !== controller) return;
        hint.textContent = '';
        if (!thoughtText) {
          const thoughts = node('details', 'thinking');
          const content = node('p', 'message-text');
          thoughtText = document.createTextNode('');
          content.append(thoughtText);
          thoughts.append(node('summary', '', '模型思考'), content);
          article.insertBefore(thoughts, body);
        }
        thoughtText.appendData(delta);
        followOutput();
      },
    });
    if (running !== controller) return;
    turn.complete = true;
    hint.className = 'sr-only';
    hint.textContent = '回复已完成。';
    const save = node('button', 'message-save', '保存这条解读');
    save.type = 'button';
    save.addEventListener('click', () => draftRecord(turn));
    article.append(save);
    if (following && !chat.hidden) thread.scrollTop = thread.scrollHeight;
  } catch (error) {
    if (running !== controller) return;
    hint.textContent = error.name === 'AbortError' ? '这次回复已停止。' : error.message;
    if (!question.value) question.value = text;
  } finally {
    thread.removeEventListener('scroll', trackScroll);
    if (frame) cancelAnimationFrame(frame);
    if (running === controller) {
      running = null;
      chatControls();
    }
  }
}

function draftRecord(selectedTurn) {
  const turn = selectedTurn || turns.findLast(item => item.complete);
  const original = material.text || turns[0]?.question || question.value.trim();
  openRecord({
    title: original.split(/\r?\n/)[0].slice(0, 60),
    material: original, source: material.source, analysis: turn?.answer || '', notes: '',
  });
}

function openRecord(record) {
  editing = record;
  for (const field of recordFields) el('record-' + field).value = record[field] || '';
  el('record-heading').textContent = record.id ? '编辑理解记录' : '保存理解记录';
  el('delete-record').hidden = !record.id;
  el('record-status').textContent = '';
  recordDialog.showModal();
}

async function changeRecord(removing) {
  if (!editing || writing) return;
  if (removing && (!editing.id || !window.confirm('删除这条记录？此浏览器保存的这条记录将被移除。'))) return;
  writing = true;
  el('save-record').disabled = true;
  el('delete-record').disabled = true;
  el('close-record').disabled = true;
  try {
    if (removing) {
      await deleteRecord(editing.id, editing.updatedAt);
    } else {
      const updated = { id: editing.id, updatedAt: editing.updatedAt };
      for (const field of recordFields) updated[field] = el('record-' + field).value;
      await putRecord(updated);
    }
    recordDialog.close();
    notice(removing ? '记录已删除。' : '已保存，可在「我的记录」中找回。');
    if (!library.hidden) await refreshRecords();
  } catch (error) {
    el('record-status').textContent = error instanceof DOMException ? '浏览器未能保存更改，请检查站点存储权限。' : error.message;
  } finally {
    writing = false;
    el('save-record').disabled = false;
    el('delete-record').disabled = false;
    el('close-record').disabled = false;
  }
}

async function refreshRecords() {
  const revision = ++listRevision;
  const query = el('search').value;
  const list = el('records-list');
  try {
    const records = await listRecords(query);
    if (revision !== listRevision) return;
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const card = node('button', 'record-card');
      card.type = 'button';
      const date = new Date(record.updatedAt);
      const time = node('time', '', date.toLocaleDateString('zh-CN'));
      time.dateTime = record.updatedAt;
      const excerpt = (record.analysis || record.notes || record.material).slice(0, 130);
      card.append(node('strong', '', record.title), time, node('span', '', excerpt));
      card.addEventListener('click', () => openRecord(record));
      fragment.append(card);
    }
    if (!records.length) fragment.append(node('p', 'list-empty', query ? '没有找到匹配的记录。' : '这个浏览器还没有保存记录。'));
    list.replaceChildren(fragment);
  } catch {
    if (revision === listRevision) list.replaceChildren(node('p', 'list-empty', '无法读取记录，请检查浏览器是否允许本站存储。'));
  }
}

el('new-chat').addEventListener('click', newChat);
el('open-records').addEventListener('click', () => setView(true));
el('back-to-chat').addEventListener('click', () => setView(false));
el('open-settings').addEventListener('click', openSettings);
el('model-button').addEventListener('click', openSettings);
provider.addEventListener('change', () => {
  keyInput.value = '';
  consent.checked = false;
  el('model').value = providers[provider.value].model;
  el('settings-status').textContent = '';
  updateRecipient();
});
el('apply-settings').addEventListener('click', applySettings);
el('close-settings').addEventListener('click', () => settings.close());
settings.addEventListener('close', () => { keyInput.value = ''; });
el('disconnect').addEventListener('click', () => {
  connection = null;
  keyInput.value = '';
  consent.checked = false;
  settings.close();
  chatControls();
  notice('本页的 API Key 已清除。');
});
el('open-material').addEventListener('click', openMaterial);
el('apply-material').addEventListener('click', applyMaterial);
el('close-material').addEventListener('click', () => materialDialog.close());
el('composer').addEventListener('submit', send);
el('stop').addEventListener('click', () => running?.abort());
question.addEventListener('input', chatControls);
question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    el('composer').requestSubmit();
  }
});
el('save-discussion').addEventListener('click', () => draftRecord());
el('search').addEventListener('input', refreshRecords);
el('save-record').addEventListener('click', () => changeRecord(false));
el('delete-record').addEventListener('click', () => changeRecord(true));
el('close-record').addEventListener('click', () => recordDialog.close());
recordDialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
recordDialog.addEventListener('close', () => {
  editing = null;
  for (const field of recordFields) el('record-' + field).value = '';
});
window.addEventListener('pagehide', () => {
  running?.abort();
  connection = null;
  keyInput.value = '';
  consent.checked = false;
  chatControls();
});
chatControls();
