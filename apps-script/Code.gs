/**
 * THE THURSDAY CUPPING CLUB — Apps Script 서버
 *
 * 하는 일
 *  1) fillBeans  : 노션 원두 DB에 상품 URL만 넣으면 원두 정보·원두 번호·별점 링크를 채움 (10분마다)
 *  2) doGet      : ttcc.inbeom.com 페이지에 원두·별점 데이터를 JSON으로 내려줌
 *  3) doPost     : 페이지에서 남긴 별점·한 줄 감상을 노션 별점 DB에 저장 (원두+멤버당 1행, 다시 누르면 덮어씀)
 *
 * 준비물: 스크립트 속성 NOTION_TOKEN (노션 내부 통합 시크릿)
 *         스크립트 속성 MEMBER_KEYS (멤버별 개인 링크 키 — issueKeys()로 생성, 저장소에는 절대 올리지 않음)
 */

const CFG = {
  NOTION_VERSION: '2022-06-28',
  BEANS_DB: '41c7b44e699a81bd94c2c005d645ac6b',
  RATINGS_DB: '41c7b44e699a8161b384cd1372c74fae',
  MEMBERS: ['IB', 'HJ', 'KC'],
  ADDERS: ['IB'],          // 레이더에서 TTCC에 담을 수 있는 멤버
  RADAR_API: 'https://script.google.com/macros/s/AKfycbyltkPYpuBj-ws6yuGGHawNtM4B5RT2jitwXkcC-qxO00G8c7a8uJSM-EY5P12B0J1Y/exec?api=lineup&part=list',
  SITE: 'https://ttcc.inbeom.com',
  CACHE_SEC: 120
};

// ---------------------------------------------------------------- 노션 기본

function notion_(method, path, body) {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('스크립트 속성 NOTION_TOKEN이 없습니다');
  const opt = {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'Notion-Version': CFG.NOTION_VERSION },
    muteHttpExceptions: true
  };
  if (body) opt.payload = JSON.stringify(body);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, opt);
    const code = res.getResponseCode();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * (attempt + 1)); continue; }
    const json = JSON.parse(res.getContentText() || '{}');
    if (code >= 400) throw new Error('Notion ' + code + ': ' + (json.message || res.getContentText()));
    return json;
  }
  throw new Error('Notion 응답 없음 (재시도 초과)');
}

function queryAll_(dbId, filter) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = notion_('post', 'databases/' + dbId + '/query', body);
    out.push.apply(out, r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

// 속성 읽기
const P = {
  text: (p) => (p && (p.title || p.rich_text) ? (p.title || p.rich_text).map((t) => t.plain_text).join('') : ''),
  num: (p) => (p && typeof p.number === 'number' ? p.number : null),
  sel: (p) => (p && p.select ? p.select.name : ''),
  multi: (p) => (p && p.multi_select ? p.multi_select.map((o) => o.name) : []),
  date: (p) => (p && p.date ? p.date.start : ''),
  url: (p) => (p && p.url ? p.url : ''),
  rel: (p) => (p && p.relation ? p.relation.map((r) => r.id.replace(/-/g, '')) : [])
};

// 속성 쓰기
const W = {
  title: (s) => ({ title: [{ text: { content: String(s).slice(0, 2000) } }] }),
  text: (s) => ({ rich_text: s ? [{ text: { content: String(s).slice(0, 2000) } }] : [] }),
  num: (n) => ({ number: n == null || isNaN(n) ? null : Number(n) }),
  sel: (s) => ({ select: s ? { name: optName_(s) } : null }),
  multi: (arr) => ({ multi_select: uniq_((arr || []).map(optName_).filter(Boolean)).slice(0, 20).map((n) => ({ name: n })) }),
  url: (s) => ({ url: s || null }),
  rel: (ids) => ({ relation: ids.map((id) => ({ id: id })) })
};

function optName_(s) { return String(s || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100); }
function uniq_(a) { return a.filter((x, i) => a.indexOf(x) === i); }
function normId_(id) { return String(id || '').replace(/-/g, ''); }

// ---------------------------------------------------------------- 1) 원두 자동 채우기

/** 10분마다 실행. 상품 URL이 있고 아직 안 채운(국가 비어 있음) 원두를 채움 */
function fillBeans() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const all = queryAll_(CFG.BEANS_DB);
    const todo = all.filter((pg) => {
      const pr = pg.properties;
      if (!P.url(pr['상품 URL']) && isUrl_(P.text(pr['원두명']))) return true;   // 원두명 칸에 URL을 붙여넣은 경우
      // SEY가 아닌 원두는 국가를 손으로 적으므로, 국가가 비어 있어도 다시 시도하지 않음
      return P.url(pr['상품 URL']) && ((isSey_(pr) && !P.sel(pr['국가'])) || !P.text(pr['원두 번호']) || !P.url(pr['별점 링크']));
    });
    if (!todo.length) return;
    const radar = radarIndex_();
    todo.forEach((pg) => {
      try { fillOne_(pg, all, radar); } catch (e) { console.error('fillOne 실패 ' + pg.id + ': ' + e.message); }
    });
  } finally {
    lock.releaseLock();
  }
}

function fillOne_(pg, all, radar) {
  const pr = pg.properties;
  const props = {};
  let url = P.url(pr['상품 URL']);
  let nameEmpty = !P.text(pr['원두명']);
  // 원두명 칸에 URL을 붙여넣었으면 상품 URL 칸으로 옮기고, 원두명은 새로 채움
  const titled = P.text(pr['원두명']).trim();
  if (!url && isUrl_(titled)) {
    url = titled;
    props['상품 URL'] = W.url(url);
    nameEmpty = true;
  }

  // 원두 정보 (국가가 비어 있을 때만 — 손으로 고친 값은 덮어쓰지 않음)
  // SEY: 레이더 목록 → Shopify. 다른 로스터리: Shopify에서 이름만(가격은 통화가 달라 손으로)
  const hit = radarFind_(radar, url);                      // 레이더에 있는 원두면 로스터리와 상관없이 다 채움
  const sey = hit ? hit.sey : isSey_(pr);
  if (hit && hit.roaster && !P.sel(pr['로스터리'])) props['로스터리'] = W.sel(hit.roaster);
  if (!P.sel(pr['국가']) && (sey || hit || !P.text(pr['원두 번호']))) {
    let info = hit || shopifyInfo_(url);
    if (info && !sey && !hit) info.price = null;            // 레이더 밖 외국 가게: 통화가 달라 가격은 손으로
    if (info) {
      if (nameEmpty && info.name) props['원두명'] = W.title(info.name);
      if (info.country) props['국가'] = W.sel(info.country);
      if (!P.text(pr['지역/생산자']) && info.origin) props['지역/생산자'] = W.text(info.origin);
      if (info.varieties.length) props['품종'] = W.multi(info.varieties);
      if (info.process) props['가공'] = W.sel(info.process);
      if (info.notes.length) props['맛 노트'] = W.multi(info.notes);
      if (P.num(pr['가격']) == null && info.price) props['가격'] = W.num(info.price);
    }
  }

  // 기본값
  if (!P.sel(pr['구분'])) props['구분'] = W.sel('구독');
  if (!P.sel(pr['상태'])) props['상태'] = W.sel('도착');

  // 원두 번호: DROP 안에서 다음 번호 (구독 01-1…, 애드온 01-A1…)
  const drop = P.num(pr['DROP']);
  if (drop && !P.text(pr['원두 번호'])) {
    const kind = P.sel(pr['구분']) || '구독';
    props['원두 번호'] = W.text(nextNo_(drop, kind, all, pg.id));
  }

  // 별점 링크
  if (!P.url(pr['별점 링크'])) props['별점 링크'] = W.url(CFG.SITE + '/#b-' + normId_(pg.id));

  if (Object.keys(props).length) notion_('patch', 'pages/' + pg.id, { properties: props });
}

const KIND_PREFIX = { '구독': '', '애드온': 'A', '추가구매': 'P' };

function nextNo_(drop, kind, all, selfId) {   // 구독 01-1 · 애드온 01-A1 · 추가구매 01-P1
  const dd = ('0' + drop).slice(-2);
  const pre = KIND_PREFIX[kind] || '';
  const re = new RegExp('-' + pre + '(\\d+)$');
  let max = 0;
  all.filter((p) => p.id !== selfId && P.num(p.properties['DROP']) === drop)
    .map((p) => P.text(p.properties['원두 번호'])).filter(Boolean)
    .forEach((n) => { const m = n.match(re); if (m) max = Math.max(max, +m[1]); });
  return dd + '-' + pre + (max + 1);
}

/** 신상 원두 레이더 API(공개) 색인 — 모든 로스터리를 상품 주소로, SEY는 상품 handle로도 찾음 */
function radarIndex_() {
  const idx = { byUrl: {}, byHandle: {} };
  try {
    const res = UrlFetchApp.fetch(CFG.RADAR_API, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return idx;
    const d = JSON.parse(res.getContentText());
    const vs = {};
    (d.vendors || []).forEach((v) => { vs[v.id] = v; });
    (d.items || []).forEach((it) => {
      const v = vs[it.vendor] || {};
      const sey = /^sey/i.test(String(v.short || v.name || it.vendor || ''));
      const info = fromRadar_(it, sey ? '' : roasterName_(v.name || v.short || it.vendor || ''), sey);
      const u = normUrl_(it.url);
      if (u) idx.byUrl[u] = info;
      const h = sey ? handleOf_(it.url) : '';
      if (h) idx.byHandle[h] = info;
    });
  } catch (e) {
    console.warn('레이더 API 실패: ' + e.message);
  }
  return idx;
}

/** 'Loquat Coffee' → 'Loquat', 'April Coffee Roasters' → 'April' (노션 라벨을 짧고 한결같게) */
function roasterName_(n) {
  n = String(n || '').trim();
  return n.replace(/\s+(coffee\s+roasters?|roasters?|coffee|caf[eé])$/i, '').trim() || n;
}

function radarFind_(radar, url) {
  if (!radar || !url) return null;
  return radar.byUrl[normUrl_(url)] || (/seycoffee/i.test(url) ? radar.byHandle[handleOf_(url)] : null) || null;
}

/** 주소 비교용: 프로토콜·www·뒤 슬래시·?·# 무시, 소문자 */
function normUrl_(u) {
  const m = String(u || '').trim().match(/^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)/i);
  return m ? (m[1] + m[2].replace(/\/+$/, '')).toLowerCase() : '';
}

function fromRadar_(it, roaster, sey) {
  const vars = Array.isArray(it.vars) && it.vars.length
    ? it.vars.map((x) => x.n)
    : String(it.variety || '').split(/\s*(?:,|\/|&|\band\b|·)\s*/i);
  const origin = [Array.isArray(it.regionSub) ? it.regionSub.join(' · ') : (it.regionTop || it.region || ''), it.producer, it.farm]
    .filter(Boolean).join(' · ');
  return {
    name: [it.producer, it.farm].filter(Boolean).join(' · ') || it.title || '',
    country: it.countryKo || '',
    origin: origin,
    varieties: vars.map((s) => s.trim()).filter(Boolean),
    process: it.procKo || it.process || '',
    notes: (it.notes || []).map((s) => String(s).trim()).filter(Boolean),
    price: basisPrice_(it),
    roaster: roaster || '',
    sey: !!sey,
    url: it.url || ''
  };
}

function basisPrice_(it) {   // 원화: 원화 판매가, 외화는 레이더가 바꿔 둔 원화(krw)
  const ss = it.sizes || [];
  const b = it.unit && ss[it.unit.i] ? ss[it.unit.i] : ss[0];
  if (!b) return null;
  if (!it.currency || it.currency === 'KRW') return b.price > 0 ? Number(b.price) : null;
  return b.krw > 0 ? Math.round(Number(b.krw)) : null;
}

/** 레이더 목록에 없을 때: Shopify 공개 상품 정보(.js)에서 이름·가격만 */
function shopifyInfo_(url) {
  try {
    const clean = url.split(/[?#]/)[0].replace(/\/$/, '');
    const res = UrlFetchApp.fetch(clean + '.js', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const p = JSON.parse(res.getContentText());
    const prices = (p.variants || []).map((v) => v.price).filter((x) => x > 0);
    return {
      name: p.title || '', country: '', origin: '', varieties: [], process: '', notes: [],
      price: prices.length ? Math.min.apply(null, prices) / 100 : null
    };
  } catch (e) {
    return null;
  }
}

function isSey_(pr) {
  const r = (P.sel(pr['로스터리']) || '').trim().toLowerCase();
  return !r || r === 'sey' || r === 'sey coffee';
}

function isUrl_(s) { return /^https?:\/\/\S+$/i.test(String(s || '').trim()); }

function handleOf_(url) {
  const m = String(url || '').match(/\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

// ---------------------------------------------------------------- 2) 페이지용 데이터 (GET)

function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (p.api === 'rate') out = saveRating_(p);          // JSONP 대비: GET으로도 저장 가능
    else if (p.api === 'preview') out = previewBean_(p.url);
    else if (p.api === 'add') out = addBean_(p);
    else if (p.api === 'whoami') out = memberOf_(p.key) ? { ok: true, member: memberOf_(p.key) } : { ok: false, error: 'KEY' };
    else out = clubData_(p.fresh === '1');
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return respond_(out, p.callback);
}

function clubData_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('club');
    if (hit) return JSON.parse(hit);
  }
  const beans = queryAll_(CFG.BEANS_DB).map((pg) => {
    const pr = pg.properties;
    return {
      id: normId_(pg.id),
      name: P.text(pr['원두명']),
      drop: P.num(pr['DROP']),
      no: P.text(pr['원두 번호']),
      kind: P.sel(pr['구분']),
      status: P.sel(pr['상태']),
      country: P.sel(pr['국가']),
      origin: P.text(pr['지역/생산자']),
      varieties: P.multi(pr['품종']),
      process: P.sel(pr['가공']),
      notes: P.multi(pr['맛 노트']),
      roast: P.date(pr['로스팅 날짜']),
      arrived: P.date(pr['도착일']),
      price: P.num(pr['가격']),
      url: P.url(pr['상품 URL']),
      roaster: isSey_(pr) ? '' : P.sel(pr['로스터리']),
      ratings: {}
    };
  }).filter((b) => b.drop && b.name);

  const byId = {};
  beans.forEach((b) => { byId[b.id] = b; });
  queryAll_(CFG.RATINGS_DB).forEach((pg) => {
    const pr = pg.properties;
    const m = P.sel(pr['멤버']);
    const score = P.num(pr['별점']);
    P.rel(pr['원두']).forEach((bid) => {
      if (byId[bid] && m && score) byId[bid].ratings[m] = { score: score, note: P.text(pr['한 줄 감상']) };
    });
  });

  beans.sort((a, b) => b.drop - a.drop || sortNo_(a.no) - sortNo_(b.no));
  const out = { ok: true, members: CFG.MEMBERS, beans: beans, at: new Date().toISOString() };
  try { cache.put('club', JSON.stringify(out), CFG.CACHE_SEC); } catch (e) { /* 100KB 초과 시 캐시 생략 */ }
  return out;
}

function sortNo_(no) {
  const m = String(no || '').match(/-([AP]?)(\d+)$/);
  return m ? ({ '': 0, A: 100, P: 200 }[m[1]]) + Number(m[2]) : 999;
}

// ---------------------------------------------------------------- 3) 별점 저장 (POST)

function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = body.api === 'add' ? addBean_(body) : saveRating_(body);
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return respond_(out);
}

function saveRating_(b) {
  const bean = normId_(b.bean);
  const member = memberOf_(b.key);                         // 멤버는 개인 링크 키로만 정해짐 (보낸 member 값은 무시)
  if (!member) throw new Error('KEY');
  const score = Number(b.score);
  if (!/^[0-9a-f]{32}$/.test(bean)) throw new Error('원두 ID가 올바르지 않습니다');
  if (CFG.MEMBERS.indexOf(member) < 0) throw new Error('멤버가 올바르지 않습니다');
  if (!(score >= 1 && score <= 5 && Math.round(score) === score)) throw new Error('별점은 1~5');
  const note = b.note == null ? null : String(b.note).slice(0, 300);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const beanPage = notion_('get', 'pages/' + bean);
    if (normId_(beanPage.parent && beanPage.parent.database_id) !== CFG.BEANS_DB) throw new Error('TTCC 원두가 아닙니다');
    const no = P.text(beanPage.properties['원두 번호']) || P.text(beanPage.properties['원두명']);

    const found = queryAll_(CFG.RATINGS_DB, {
      and: [
        { property: '원두', relation: { contains: bean } },
        { property: '멤버', select: { equals: member } }
      ]
    });
    const props = { '기록': W.title(no + ' · ' + member), '별점': W.num(score) };
    if (note !== null) props['한 줄 감상'] = W.text(note);

    if (found.length) {
      notion_('patch', 'pages/' + found[0].id, { properties: props });
    } else {
      props['원두'] = W.rel([bean]);
      props['멤버'] = W.sel(member);
      notion_('post', 'pages', { parent: { database_id: CFG.RATINGS_DB }, properties: props });
    }
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('club');
  return { ok: true };
}

// ---------------------------------------------------------------- 4) 레이더에서 TTCC에 담기

const KINDS = ['구독', '애드온', '추가구매'];
const ADD_LIMIT_PER_DAY = 10;

function findByUrl_(all, url) {
  const u = normUrl_(url);
  return u ? all.find((pg) => normUrl_(P.url(pg.properties['상품 URL'])) === u) || null : null;
}

function latestDrop_(all) {
  return all.reduce((m, pg) => Math.max(m, P.num(pg.properties['DROP']) || 0), 0);
}

/** 담기 전 확인 화면용 (공개 레이더 정보만) — 레이더에 없는 주소는 found:false */
function previewBean_(url) {
  const radar = radarIndex_();
  const hit = radarFind_(radar, url);
  const all = queryAll_(CFG.BEANS_DB);
  const dup = findByUrl_(all, url);
  return {
    ok: true, found: !!hit,
    item: hit ? { name: hit.name, roaster: hit.sey ? 'SEY' : hit.roaster, country: hit.country, process: hit.process, notes: hit.notes, price: hit.price, sey: hit.sey } : null,
    dup: dup ? normId_(dup.id) : null,
    latestDrop: latestDrop_(all)
  };
}

/** 멤버 키 확인 → 레이더에 있는 원두만 → 중복·하루 횟수 확인 → 노션에 한 줄 + 바로 채우기 */
function addBean_(b) {
  const member = memberOf_(b.key);
  if (!member) throw new Error('KEY');
  if (CFG.ADDERS.indexOf(member) < 0) throw new Error('NOT_ADDER');
  const drop = Number(b.drop);
  if (!(drop >= 1 && drop <= 999 && Math.round(drop) === drop)) throw new Error('DROP');
  const kind = String(b.kind || '');
  if (KINDS.indexOf(kind) < 0) throw new Error('KIND');
  const radar = radarIndex_();
  const hit = radarFind_(radar, b.url);
  if (!hit) throw new Error('NOT_IN_RADAR');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const all = queryAll_(CFG.BEANS_DB);
    const dup = findByUrl_(all, hit.url || b.url);
    if (dup) return { ok: false, error: 'DUP', id: normId_(dup.id) };

    const sp = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    let cnt = {};
    try { cnt = JSON.parse(sp.getProperty('ADD_COUNT') || '{}'); } catch (e) { cnt = {}; }
    if (cnt.day !== today) cnt = { day: today };
    if ((cnt[member] || 0) >= ADD_LIMIT_PER_DAY) throw new Error('LIMIT');

    const page = notion_('post', 'pages', { parent: { database_id: CFG.BEANS_DB }, properties: {
      '원두명': W.title(hit.name || '새 원두'),
      '상품 URL': W.url(hit.url || b.url),
      'DROP': W.num(drop),
      '구분': W.sel(kind),
      '상태': W.sel('미도착'),
      '담은 사람': W.sel(member)
    } });
    cnt[member] = (cnt[member] || 0) + 1;
    sp.setProperty('ADD_COUNT', JSON.stringify(cnt));
    try { fillOne_(page, all.concat([page]), radar); } catch (e) { console.error('담은 뒤 채우기 실패: ' + e.message); }
    CacheService.getScriptCache().remove('club');
    return { ok: true, id: normId_(page.id) };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- 개인 링크 키

function keys_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('MEMBER_KEYS') || '{}'); } catch (e) { return {}; }
}

/** 키 → 멤버 (없으면 '') */
function memberOf_(key) {
  key = String(key || '');
  if (!/^[0-9a-f]{24}$/.test(key)) return '';
  const ks = keys_();
  for (const m in ks) if (ks[m] === key && CFG.MEMBERS.indexOf(m) >= 0) return m;
  return '';
}

function newKey_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 24); }

function logLinks_(ks, only) {
  CFG.MEMBERS.filter((m) => !only || m === only).forEach((m) => console.log(m + '  ' + CFG.SITE + '/#key=' + ks[m]));
}

/** 처음 1회: 세 멤버의 개인 링크를 만들고 실행 로그에 출력 (이미 있으면 그대로 보여줌) */
function issueKeys() {
  const ks = keys_();
  CFG.MEMBERS.forEach((m) => { if (!ks[m]) ks[m] = newKey_(); });
  PropertiesService.getScriptProperties().setProperty('MEMBER_KEYS', JSON.stringify(ks));
  logLinks_(ks);
}

/** 링크가 샜을 때: 해당 멤버 키만 새로 발급 (이전 링크는 즉시 무효) */
function reissue_(m) {
  const ks = keys_();
  ks[m] = newKey_();
  PropertiesService.getScriptProperties().setProperty('MEMBER_KEYS', JSON.stringify(ks));
  logLinks_(ks, m);
}
function reissueIB() { reissue_('IB'); }
function reissueHJ() { reissue_('HJ'); }
function reissueKC() { reissue_('KC'); }

// ---------------------------------------------------------------- 공통

function respond_(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback && /^[\w$.]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 설치·점검 (편집기에서 직접 실행)

/** 1회 실행: 10분마다 fillBeans 실행 */
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'fillBeans')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('fillBeans').timeBased().everyMinutes(10).create();
  console.log('fillBeans 트리거 설치 완료 (10분마다)');
}

/** 노션 연결 확인: 토큰·페이지 연결이 맞으면 두 DB 이름과 행 수가 찍힘 */
function testNotion() {
  [CFG.BEANS_DB, CFG.RATINGS_DB].forEach((id) => {
    const db = notion_('get', 'databases/' + id);
    const n = queryAll_(id).length;
    console.log('OK  ' + P.text({ title: db.title }) + ' — ' + n + '행');
  });
  console.log('레이더 원두 ' + Object.keys(radarIndex_().byUrl).length + '종 확인');
}

/** 페이지 데이터 미리보기 */
function testData() {
  console.log(JSON.stringify(clubData_(true), null, 2).slice(0, 4000));
}
