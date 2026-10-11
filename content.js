(() => {
  'use strict';

  // 홈(대시보드) 화면에서만 동작
  const HOME_PATHS = ['/', '/index.php', '/my/', '/my/index.php'];
  if (!HOME_PATHS.includes(location.pathname)) return;

  const CACHE_TTL = 10 * 60 * 1000; // 10분
  const CONCURRENCY = 3;
  const SOON = 2 * 24 * 3600 * 1000; // 48시간 이내면 긴급 표시
  const log = (...a) => console.debug('[iclass-check]', ...a);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).replace(/\s/g, '').toLowerCase();
  const abs = (href) => (href ? new URL(href, location.origin).href : null);

  // ---------- 파싱 유틸 ----------

  // "2024-03-10 23:59:59", "2024년 3월 10일 일요일 오후 11:59" 모두 지원
  const DATE_RE = /(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\D*?(?:(오전|오후|AM|PM)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?/gi;

  function parseDates(text) {
    const out = [];
    for (const m of (text || '').matchAll(DATE_RE)) {
      let h = +m[5];
      const ap = (m[4] || '').toUpperCase();
      if ((ap === '오후' || ap === 'PM') && h < 12) h += 12;
      if ((ap === '오전' || ap === 'AM') && h === 12) h = 0;
      out.push(new Date(+m[1], +m[2] - 1, +m[3], h, +m[6], +(m[7] || 0)).getTime());
    }
    return out;
  }

  // "41:02" 또는 "1:02:33" → 초
  function parseDuration(s) {
    const m = (s || '').match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }

  async function fetchDoc(path) {
    const res = await fetch(new URL(path, location.origin), { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    if (/login/.test(new URL(res.url).pathname)) throw new Error('로그인 필요');
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  // ---------- 페이지별 파서 ----------

  function activityTitle(li) {
    const inst = li.querySelector('.instancename');
    if (!inst) return clean(li.textContent);
    const c = inst.cloneNode(true);
    c.querySelectorAll('.accesshide').forEach((x) => x.remove());
    return clean(c.textContent);
  }

  // 강의 메인 페이지: 활동 목록 + 학습 기간 + 완료 체크 아이콘
  function parseCoursePage(doc) {
    return [...doc.querySelectorAll('li.activity')].map((li) => {
      const type = (li.className.match(/modtype_(\w+)/) || [])[1] || '';
      const a = li.querySelector('a[href*="/mod/"]');
      const dates = parseDates(li.querySelector('.displayoptions, .text-ubstrap')?.textContent);
      const img = li.querySelector('.autocompletion img, .togglecompletion img, img[src*="completion-"]');
      let completed = null;
      if (img) {
        const src = img.getAttribute('src') || '';
        if (/completion-(auto|manual)-(y|pass)/.test(src)) completed = true;
        else if (/completion-(auto|manual)-(n|fail)/.test(src)) completed = false;
      }
      return {
        type,
        title: activityTitle(li),
        url: abs(a?.getAttribute('href')),
        start: dates.length >= 2 ? dates[0] : null,
        end: dates.length >= 2 ? dates[1] : dates[0] ?? null,
        completed,
      };
    });
  }

  // 학습진도현황(온라인 출석부): 영상별 요구시간 vs 학습시간
  function parseProgress(doc) {
    const table =
      doc.querySelector('table.user_progress_table, table.user_progress') ||
      [...doc.querySelectorAll('table')].find((t) => /출석|진도|학습시간/.test(t.querySelector('thead')?.textContent || ''));
    if (!table) return null;
    const items = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = [...tr.querySelectorAll('td')];
      const ti = cells.findIndex((td) => td.classList.contains('text-left') || td.querySelector('img.activityicon, img.icon'));
      if (ti < 0) return;
      const title = clean(cells[ti].textContent);
      if (!title) return;
      const rest = cells.slice(ti + 1);
      const durs = rest.map((td) => parseDuration(td.textContent)).filter((v) => v != null);
      const marks = rest.map((td) => clean(td.textContent)).filter((t) => /^(O|X|▲|△)$/i.test(t));
      let done = null;
      if (durs.length >= 2) done = durs[1] >= durs[0];
      else if (marks.length) done = marks[0].toUpperCase() === 'O';
      else if (durs.length === 1) done = false; // 요구시간만 있고 학습기록 없음
      items.push({ title, done });
    });
    return items;
  }

  // 과제 목록: 과제명 / 종료 일시 / 제출 여부
  function parseAssignIndex(doc) {
    const table = doc.querySelector('table.generaltable');
    if (!table) return [];
    const heads = [...table.querySelectorAll('thead th')].map((th) => clean(th.textContent));
    const col = (re) => heads.findIndex((h) => re.test(h));
    const ci = { name: col(/과제|assignment/i), due: col(/종료|마감|due/i), sub: col(/제출|submission/i) };
    if (ci.name < 0) return [];
    return [...table.querySelectorAll('tbody tr')]
      .map((tr) => {
        const cells = tr.querySelectorAll('td');
        const a = cells[ci.name]?.querySelector('a');
        if (!a) return null;
        const subText = clean(cells[ci.sub]?.textContent);
        const submitted = /미제출|제출\s*안|제출하지|no submission|not submitted/i.test(subText)
          ? false
          : /제출\s*완료|제출됨|submitted/i.test(subText);
        return {
          title: clean(a.textContent),
          url: abs(a.getAttribute('href')),
          due: parseDates(cells[ci.due]?.textContent)[0] ?? null,
          submitted,
        };
      })
      .filter(Boolean);
  }

  // ---------- 분석 ----------

  function classify(done, start, end, now) {
    if (done) return 'done';
    if (start && start > now) return 'upcoming';
    if (end && end < now) return 'missed';
    return 'todo';
  }

  async function fetchProgress(id) {
    for (const p of ['user_progress_a.php', 'user_progress.php']) {
      try {
        const items = parseProgress(await fetchDoc(`/report/ubcompletion/${p}?id=${id}`));
        if (items && items.length) return items;
      } catch (e) {
        log('progress', id, p, e.message);
      }
    }
    return null;
  }

  async function analyzeCourse(id) {
    const [acts, progress, assigns] = await Promise.all([
      fetchDoc(`/course/view.php?id=${id}`).then(parseCoursePage),
      fetchProgress(id),
      fetchDoc(`/mod/assign/index.php?id=${id}`).then(parseAssignIndex).catch(() => []),
    ]);
    const now = Date.now();
    const vods = acts.filter((a) => a.type === 'vod');
    const findVod = (title) => {
      const t = norm(title);
      return vods.find((v) => norm(v.title) === t) || vods.find((v) => norm(v.title).includes(t) || t.includes(norm(v.title)));
    };

    let videos;
    if (progress) {
      videos = progress.map((p) => {
        const v = findVod(p.title) || {};
        return { title: p.title, url: v.url, start: v.start, end: v.end, done: p.done ?? v.completed ?? false };
      });
    } else {
      // 진도 페이지가 없으면 강의 페이지의 완료 체크 아이콘으로 대체
      videos = vods.filter((v) => v.completed !== null).map((v) => ({ ...v, done: v.completed }));
    }

    return {
      videos: videos.map((v) => ({ ...v, kind: 'video', status: classify(v.done, v.start, v.end, now) })),
      assigns: assigns.map((a) => ({ ...a, kind: 'assign', end: a.due, status: classify(a.submitted, null, a.due, now) })),
      source: progress ? 'progress' : 'completion',
    };
  }

  async function getCourse(id, force) {
    const key = `icc:${id}`;
    if (!force) {
      const hit = (await chrome.storage.local.get(key))[key];
      if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
    }
    const data = await analyzeCourse(id);
    await chrome.storage.local.set({ [key]: { t: Date.now(), data } });
    return data;
  }

  // ---------- 홈 화면의 강의 찾기 ----------

  function findCourses() {
    const selectors = [
      '.course_lists a[href*="/course/view.php?id="]',
      '.my-course-lists a[href*="/course/view.php?id="]',
      '#region-main a[href*="/course/view.php?id="]',
    ];
    let links = [];
    for (const s of selectors) {
      links = [...document.querySelectorAll(s)];
      if (links.length) break;
    }
    const map = new Map();
    for (const a of links) {
      const id = new URL(a.href).searchParams.get('id');
      if (!id || id === '1' || map.has(id)) continue;
      const title = clean(a.querySelector('.course-title h3, h3, .coursename')?.textContent || a.textContent);
      map.set(id, { id, title, anchor: a });
    }
    return [...map.values()];
  }

  // ---------- UI ----------

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function dueLabel(ts) {
    if (!ts) return '기한 없음';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const s = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const diff = ts - Date.now();
    if (diff < 0) return `${s} 지남`;
    const hours = diff / 3600000;
    return `${s} (${hours < 24 ? `${Math.floor(hours)}시간 남음` : `D-${Math.ceil(hours / 24)}`})`;
  }

  const minEnd = (items) => Math.min(...items.map((i) => i.end || Infinity));
  const isSoon = (items) => minEnd(items) - Date.now() < SOON;
  const byEnd = (a, b) => (a.end || Infinity) - (b.end || Infinity);

  function itemRow(item, courseTitle) {
    const row = h('a', 'icc-item');
    if (item.url) row.href = item.url;
    if (item.end && item.end - Date.now() < SOON) row.classList.add('icc-soon');
    row.append(h('span', 'icc-kind', item.kind === 'video' ? '영상' : '과제'));
    const body = h('span', 'icc-item-body');
    if (courseTitle) body.append(h('span', 'icc-item-course', courseTitle));
    body.append(h('span', 'icc-item-title', item.title));
    row.append(body, h('span', 'icc-item-due', dueLabel(item.end)));
    return row;
  }

  function mountBox(course) {
    const box = h('div', 'icc-box');
    const li = course.anchor.closest('li');
    // 카드 전체가 <a>로 감싸져 있으므로 링크 바깥에 붙인다
    if (li && !course.anchor.contains(li)) li.append(box);
    else course.anchor.after(box);
    box.addEventListener('click', (e) => {
      if (e.target.closest('a.icc-item')) return;
      e.preventDefault();
      e.stopPropagation();
      box.classList.toggle('icc-open');
    });
    setLoading(box);
    return box;
  }

  function setLoading(box) {
    box.textContent = '';
    box.append(h('span', 'icc-muted', '확인 중…'));
  }

  // 마감이 지난 항목(missed)은 표시하지 않는다
  function renderBox(box, data) {
    box.textContent = '';
    const vTodo = data.videos.filter((v) => v.status === 'todo');
    const aTodo = data.assigns.filter((a) => a.status === 'todo');

    const line = h('div', 'icc-line');
    const stat = (text, items) => line.append(h('span', `icc-stat${isSoon(items) ? ' icc-soon' : ''}`, text));
    if (vTodo.length) stat(`미시청 영상 ${vTodo.length}`, vTodo);
    if (aTodo.length) {
      const rel = dueLabel(minEnd(aTodo)).match(/\((.*)\)/)?.[1];
      stat(`미제출 과제 ${aTodo.length}${rel ? ` (${rel})` : ''}`, aTodo);
    }
    if (!line.childElementCount) line.append(h('span', 'icc-muted', '남은 할 일 없음'));
    box.append(line);

    const list = h('div', 'icc-list');
    [...vTodo, ...aTodo].sort(byEnd).forEach((i) => list.append(itemRow(i)));
    list.append(h('div', 'icc-meta', `영상 ${data.videos.filter((v) => v.done).length}/${data.videos.length} 시청 · 과제 ${data.assigns.filter((a) => a.submitted).length}/${data.assigns.length} 제출`));
    box.append(list);
  }

  function renderError(box, err) {
    box.textContent = '';
    box.append(h('span', 'icc-muted', `불러오지 못함 (${err.message})`));
  }

  // 페이지의 '교과과정' 헤더에 있는 접기 아이콘을 빌려 쓴다. 못 찾으면 CSS로 그린 화살표
  function makeArrow() {
    const label = [...document.querySelectorAll('h1,h2,h3,h4,h5,div,span,a,button')].find(
      (el) => el.childElementCount === 0 && clean(el.textContent) === '교과과정'
    );
    const header = label?.closest('[class*="head"], [class*="title"], [class*="toggle"], h1, h2, h3, h4, h5, button, a') || label?.parentElement;
    const icon = header?.parentElement?.querySelector('i, img, svg, [class*="arrow"], [class*="toggle"], [class*="caret"], [class*="fold"]');
    if (icon && icon !== label && !icon.contains(label)) {
      const c = icon.cloneNode(true);
      c.removeAttribute('id');
      c.classList.add('icc-arrow', 'icc-arrow-cloned');
      log('arrow cloned from 교과과정', icon);
      return c;
    }
    return h('span', 'icc-arrow icc-arrow-css');
  }

  // 강의 목록 위에 붙는 전체 할 일 목록
  function mountSummary(courses, onRefresh) {
    const wrap = h('div', 'icc-summary');
    const head = h('div', 'icc-summary-head');
    const title = h('span', 'icc-summary-title', '할 일');
    const refresh = h('a', 'icc-refresh', '새로고침');
    refresh.href = '#';
    refresh.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRefresh();
    });
    const actions = h('span', 'icc-summary-actions');
    actions.append(refresh, makeArrow());
    head.append(title, actions);
    const body = h('div', 'icc-summary-body');
    const clip = h('div', 'icc-summary-clip');
    clip.append(body);
    wrap.append(head, clip);

    // 헤더 어디를 눌러도 접기/펼치기. 상태는 저장해 두고 다음 방문에도 유지
    const COLLAPSE_KEY = 'icc:summaryCollapsed';
    const setCollapsed = (v, animate) => {
      if (wrap.classList.contains('icc-collapsed') === v) return;
      wrap.classList.toggle('icc-collapsed', v);
      if (!animate) {
        clip.style.height = v ? '0px' : '';
        return;
      }
      // auto 높이는 transition이 안 되므로 실제 높이를 거쳐서 애니메이션
      clip.style.height = v ? `${clip.scrollHeight}px` : '0px';
      clip.offsetHeight; // reflow
      clip.style.height = v ? '0px' : `${clip.scrollHeight}px`;
    };
    clip.addEventListener('transitionend', () => {
      if (!wrap.classList.contains('icc-collapsed')) clip.style.height = '';
    });
    head.addEventListener('click', (e) => {
      if (e.target.closest('.icc-refresh')) return;
      const v = !wrap.classList.contains('icc-collapsed');
      setCollapsed(v, true);
      chrome.storage.local.set({ [COLLAPSE_KEY]: v });
    });
    chrome.storage.local.get(COLLAPSE_KEY).then((r) => setCollapsed(!!r[COLLAPSE_KEY], false));

    const listEl = courses[0].anchor.closest('.course_lists, .my-course-lists, ul');
    if (listEl?.parentNode) listEl.parentNode.insertBefore(wrap, listEl);
    else (document.querySelector('#region-main') || document.body).prepend(wrap);

    return {
      update(results) {
        const all = [];
        for (const { course, data } of results) {
          [...data.videos, ...data.assigns]
            .filter((i) => i.status === 'todo')
            .forEach((i) => all.push({ i, course }));
        }
        all.sort((a, b) => byEnd(a.i, b.i));
        title.textContent = `할 일 ${all.length}`;
        body.textContent = '';
        if (!all.length) body.append(h('div', 'icc-meta', '남은 영상과 과제가 없습니다.'));
        all.forEach(({ i, course }) => body.append(itemRow(i, course.title)));
      },
      loading() {
        title.textContent = '할 일';
        body.textContent = '';
        body.append(h('div', 'icc-meta', '확인 중…'));
      },
    };
  }

  // ---------- 실행 ----------

  async function run(courses, boxes, summary, force) {
    summary.loading();
    const results = [];
    let idx = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (idx < courses.length) {
          const course = courses[idx++];
          const box = boxes.get(course.id);
          try {
            const data = await getCourse(course.id, force);
            log(course.title, data);
            renderBox(box, data);
            results.push({ course, data });
          } catch (e) {
            log('fail', course.title, e);
            renderError(box, e);
          }
        }
      })
    );
    summary.update(results);
  }

  const courses = findCourses();
  log('courses', courses);
  if (!courses.length) return;

  const boxes = new Map(courses.map((c) => [c.id, mountBox(c)]));
  const summary = mountSummary(courses, () => {
    boxes.forEach(setLoading);
    run(courses, boxes, summary, true);
  });
  run(courses, boxes, summary, false);
})();
