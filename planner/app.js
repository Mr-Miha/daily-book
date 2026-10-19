/* Ежедневник — календарь, записи и напоминания.
 * Чистый JavaScript, без сборки и внешних зависимостей.
 * Данные хранятся в localStorage; предусмотрен экспорт/импорт JSON.
 *
 * Перенос на Android:
 *  - как PWA (установка на главный экран, офлайн, веб-уведомления);
 *  - как нативное приложение через Capacitor — см. README.md.
 *    При наличии window.Capacitor.Plugins.LocalNotifications скрипт
 *    автоматически планирует системные уведомления на нужные даты.
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- константы

  const ENTRIES_KEY = "planner.entries.v1";
  const SETTINGS_KEY = "planner.settings.v1";

  const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const WEEKDAYS_FULL = [
    "воскресенье", "понедельник", "вторник", "среда",
    "четверг", "пятница", "суббота",
  ];
  const MONTHS = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
  ];
  const MONTHS_GEN = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];

  const REPEAT_LABELS = {
    none: "без повтора",
    daily: "ежедневно",
    weekly: "еженедельно",
    monthly: "ежемесячно",
    yearly: "ежегодно",
  };
  const REPEATS = Object.keys(REPEAT_LABELS);

  const DEFAULT_TIME = "09:00";
  const CHECK_INTERVAL_MS = 30 * 1000;
  const CATCHUP_MS = 24 * 60 * 60 * 1000; // догоняем пропущенные за сутки

  // ------------------------------------------------------------------ утилиты

  const pad = (n) => String(n).padStart(2, "0");

  function isoOf(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function parseISO(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    if (!y || !m || !d) return new Date();
    return new Date(y, m - 1, d);
  }

  function todayISO() {
    return isoOf(new Date());
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function plural(n, forms) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
    return forms[2];
  }

  function hashId(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h % 2147483647) + 1;
  }

  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("toast--show");
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => {
      el.classList.remove("toast--show");
    }, 3200);
  }

  // ------------------------------------------------------------- состояние

  let entries = [];
  const state = {
    selectedDate: todayISO(),
    viewMonth: null, // Date, первое число отображаемого месяца
  };

  function loadState() {
    try {
      const rawEntries = JSON.parse(localStorage.getItem(ENTRIES_KEY) || "[]");
      entries = Array.isArray(rawEntries) ? rawEntries.map(normalizeEntry) : [];
    } catch (err) {
      console.warn("Не удалось прочитать записи:", err);
      entries = [];
    }

    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      if (typeof saved.selectedDate === "string") {
        state.selectedDate = saved.selectedDate;
      }
    } catch (err) {
      console.warn("Не удалось прочитать настройки:", err);
    }

    const base = parseISO(state.selectedDate);
    state.viewMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  }

  function saveEntries() {
    try {
      localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
    } catch (err) {
      console.error(err);
      toast("Не удалось сохранить данные (хранилище переполнено?)");
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ selectedDate: state.selectedDate }),
      );
    } catch (err) {
      console.warn(err);
    }
  }

  function normalizeEntry(raw) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || "")
      ? raw.date
      : todayISO();
    const time = /^\d{2}:\d{2}$/.test(raw.time || "") ? raw.time : "";
    return {
      id: String(raw.id || uid()),
      date,
      time,
      title: String(raw.title || "Без названия").slice(0, 120),
      note: String(raw.note || "").slice(0, 2000),
      done: Boolean(raw.done),
      remind: Boolean(raw.remind),
      repeat: REPEATS.includes(raw.repeat) ? raw.repeat : "none",
      createdAt: Number(raw.createdAt) || Date.now(),
      lastNotified: raw.lastNotified ? String(raw.lastNotified) : null,
    };
  }

  // -------------------------------------------------------- расчёт повторений

  function timeParts(entry) {
    const [h, m] = (entry.time || DEFAULT_TIME).split(":").map(Number);
    return { h: h || 0, m: m || 0 };
  }

  function baseDate(entry) {
    const [y, mo, d] = entry.date.split("-").map(Number);
    const { h, m } = timeParts(entry);
    return new Date(y, mo - 1, d, h, m, 0, 0);
  }

  function makeAt(base, year, month, day) {
    const { h, m } = timeParts(base);
    return new Date(year, month, day, h, m, 0, 0);
  }

  /**
   * Возвращает последнее наступление напоминания (<= now) и следующее (> now).
   * Для повторяющихся записей учитывается дата начала.
   */
  function occurrence(entry, now) {
    const start = baseDate(entry);
    if (entry.repeat === "none" || now < start) {
      return {
        last: start <= now ? start : null,
        next: start > now ? start : null,
      };
    }

    const step = entry.repeat;
    let last = new Date(start);
    let next = null;

    if (step === "daily" || step === "weekly") {
      const stepMs = (step === "daily" ? 1 : 7) * 24 * 60 * 60 * 1000;
      const diff = Math.floor((now.getTime() - start.getTime()) / stepMs);
      last = new Date(start.getTime() + diff * stepMs);
      if (last.getTime() > now.getTime()) {
        last = new Date(last.getTime() - stepMs);
      }
      next = new Date(last.getTime() + stepMs);
    } else if (step === "monthly") {
      let k =
        (now.getFullYear() - start.getFullYear()) * 12 +
        (now.getMonth() - start.getMonth());
      last = makeAt(entry, start.getFullYear(), start.getMonth() + k, start.getDate());
      if (last.getTime() > now.getTime()) {
        k -= 1;
        last = makeAt(entry, start.getFullYear(), start.getMonth() + k, start.getDate());
      }
      next = makeAt(entry, start.getFullYear(), start.getMonth() + k + 1, start.getDate());
    } else if (step === "yearly") {
      let k = now.getFullYear() - start.getFullYear();
      last = makeAt(entry, start.getFullYear() + k, start.getMonth(), start.getDate());
      if (last.getTime() > now.getTime()) {
        k -= 1;
        last = makeAt(entry, start.getFullYear() + k, start.getMonth(), start.getDate());
      }
      next = makeAt(entry, start.getFullYear() + k + 1, start.getMonth(), start.getDate());
    }

    if (last.getTime() < start.getTime()) last = null;
    if (next && next.getTime() < start.getTime()) next = new Date(start);
    return { last, next };
  }

  function nextAfter(entry, when) {
    const step = entry.repeat || "none";
    if (step === "none") return null;
    const d = new Date(when);
    if (step === "daily") d.setDate(d.getDate() + 1);
    else if (step === "weekly") d.setDate(d.getDate() + 7);
    else if (step === "monthly") d.setMonth(d.getMonth() + 1);
    else if (step === "yearly") d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  function upcomingOccurrences(entry, from, limit) {
    const out = [];
    let cursor = occurrence(entry, from).next;
    let guard = 0;
    while (cursor && out.length < limit && guard < limit + 60) {
      out.push(cursor);
      cursor = nextAfter(entry, cursor);
      guard += 1;
    }
    return out;
  }

  function occurrenceKey(entry, when) {
    return `${entry.id}|${isoOf(when)}|${entry.time || DEFAULT_TIME}`;
  }

  // ------------------------------------------------------- уведомления (веб)

  function webNotificationsSupported() {
    return "Notification" in window;
  }

  function notificationGranted() {
    if (isNative()) return true; // проверяется отдельно через Capacitor
    return webNotificationsSupported() && Notification.permission === "granted";
  }

  async function ensureNotificationPermission() {
    if (isNative()) {
      const plugin = localNotifications();
      if (!plugin) return false;
      try {
        const res = await plugin.requestPermissions();
        return res.display === "granted";
      } catch (err) {
        console.warn("Не удалось запросить разрешение:", err);
        return false;
      }
    }
    if (!webNotificationsSupported()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try {
      return (await Notification.requestPermission()) === "granted";
    } catch (err) {
      console.warn(err);
      return false;
    }
  }

  async function showWebNotification(entry, when) {
    if (!notificationGranted()) return;
    const title = entry.title;
    const body = entry.note
      ? entry.note
      : `${entry.time || DEFAULT_TIME} · ${entry.date === todayISO() ? "сегодня" : entry.date}`;
    const options = {
      body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: `planner-${entry.id}`,
      data: { entryId: entry.id },
    };
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(title, options);
      else new Notification(title, options);
    } catch (err) {
      console.warn("Не удалось показать уведомление:", err);
    }
  }

  async function showReminder(entry, when) {
    if (isNative()) {
      const plugin = localNotifications();
      if (plugin) {
        try {
          await plugin.schedule({
            notifications: [
              {
                id: hashId(`${entry.id}|${when.toISOString()}`),
                title: entry.title,
                body: entry.note || "Напоминание из ежедневника",
                schedule: { at: new Date(Date.now() + 1500) },
                extra: { entryId: entry.id },
              },
            ],
          });
          return;
        } catch (err) {
          console.warn("Нативное уведомление не отправлено:", err);
        }
      }
    }
    await showWebNotification(entry, when);
  }

  // ---------------------------------------------- уведомления (Capacitor/Android)

  function isNative() {
    const cap = window.Capacitor;
    return Boolean(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
  }

  function localNotifications() {
    const cap = window.Capacitor;
    return cap && cap.Plugins ? cap.Plugins.LocalNotifications || null : null;
  }

  /**
   * Перепланирует все системные уведомления (только в нативной сборке).
   * Для повторяющихся записей создаёт расписание на 20 ближайших срабатываний.
   */
  async function syncNativeSchedules() {
    if (!isNative()) return;
    const plugin = localNotifications();
    if (!plugin) return;

    try {
      const pending = await plugin.getPending();
      if (pending && pending.notifications && pending.notifications.length) {
        await plugin.cancel({
          notifications: pending.notifications.map((n) => ({ id: n.id })),
        });
      }
    } catch (err) {
      console.warn("Не удалось очистить старое расписание:", err);
    }

    const now = new Date();
    const jobs = [];
    for (const entry of entries) {
      if (!entry.remind || entry.done) continue;
      const limit = entry.repeat === "none" ? 1 : 20;
      for (const when of upcomingOccurrences(entry, now, limit)) {
        jobs.push({
          id: hashId(`${entry.id}|${when.toISOString()}`),
          title: entry.title,
          body: entry.note || "Напоминание из ежедневника",
          schedule: { at: when, allowWhileIdle: true },
          extra: { entryId: entry.id },
        });
      }
    }

    if (!jobs.length) return;
    try {
      await plugin.schedule({ notifications: jobs });
    } catch (err) {
      console.warn("Не удалось запланировать уведомления:", err);
    }
  }

  // --------------------------------------------------------- проверка напоминаний

  async function checkReminders() {
    const now = new Date();
    const due = [];

    for (const entry of entries) {
      if (!entry.remind || entry.done) continue;
      const { last } = occurrence(entry, now);
      if (!last) continue;

      const key = occurrenceKey(entry, last);
      if (entry.lastNotified === key) continue;

      const age = now.getTime() - last.getTime();
      if (age < 0) continue;

      if (age > CATCHUP_MS) {
        // слишком старое — не тревожим, просто помечаем
        entry.lastNotified = key;
        saveEntries();
        continue;
      }

      due.push({ entry, when: last, key });
    }

    if (!due.length) return;

    if (!notificationGranted() && !isNative()) return;
    if (isNative() && !localNotifications()) return;

    if (due.length > 3) {
      const first = due[0].entry.title;
      await showWebNotification(
        { id: "summary", title: `Пропущено напоминаний: ${due.length}`, note: `Например: ${first}`, time: "", date: todayISO() },
        new Date(),
      );
    } else {
      for (const item of due) {
        await showReminder(item.entry, item.when);
      }
    }

    for (const item of due) {
      item.entry.lastNotified = item.key;
    }
    saveEntries();
  }

  // ------------------------------------------------------------------ рендер

  const calendarGrid = document.getElementById("calendarGrid");
  const monthTitle = document.getElementById("monthTitle");
  const entryList = document.getElementById("entryList");
  const emptyState = document.getElementById("emptyState");
  const dayTitle = document.getElementById("dayTitle");
  const dayCount = document.getElementById("dayCount");
  const headerSubtitle = document.getElementById("headerSubtitle");

  function renderCalendar() {
    const year = state.viewMonth.getFullYear();
    const month = state.viewMonth.getMonth();
    monthTitle.textContent = `${MONTHS[month]} ${year}`;

    const today = todayISO();
    const byDate = new Map();
    for (const entry of entries) {
      const slot = byDate.get(entry.date) || { entry: false, remind: false };
      slot.entry = true;
      if (entry.remind) slot.remind = true;
      byDate.set(entry.date, slot);
    }

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // неделя начинается с понедельника
    calendarGrid.innerHTML = "";

    for (let i = 0; i < 42; i += 1) {
      const d = new Date(year, month, 1 - offset + i);
      const iso = isoOf(d);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "day-cell";
      btn.dataset.date = iso;
      btn.title = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;

      if (d.getMonth() !== month) btn.classList.add("day-cell--other");
      if (iso === today) btn.classList.add("day-cell--today");
      if (iso === state.selectedDate) {
        btn.classList.add("day-cell--selected");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.setAttribute("aria-pressed", "false");
      }

      btn.appendChild(document.createTextNode(String(d.getDate())));

      const info = byDate.get(iso);
      if (info) {
        const dots = document.createElement("span");
        dots.className = "day-cell__dots";
        if (info.entry) {
          const dot = document.createElement("span");
          dot.className = "dot dot--entry";
          dots.appendChild(dot);
        }
        if (info.remind) {
          const dot = document.createElement("span");
          dot.className = "dot dot--remind";
          dots.appendChild(dot);
        }
        btn.appendChild(dots);
      }

      btn.addEventListener("click", () => selectDate(iso));
      calendarGrid.appendChild(btn);
    }
  }

  function selectDate(iso) {
    state.selectedDate = iso;
    const d = parseISO(iso);
    state.viewMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    saveSettings();
    renderAll();
  }

  function sortedDayEntries(iso) {
    return entries
      .filter((entry) => entry.date === iso)
      .sort((a, b) => {
        if (a.time && b.time) return a.time.localeCompare(b.time) || a.createdAt - b.createdAt;
        if (a.time) return -1;
        if (b.time) return 1;
        return a.createdAt - b.createdAt;
      });
  }

  function makeTag(text, modifier) {
    const span = document.createElement("span");
    span.className = `tag${modifier ? ` tag--${modifier}` : ""}`;
    span.textContent = text;
    return span;
  }

  function renderDay() {
    const iso = state.selectedDate;
    const date = parseISO(iso);
    const label = `${WEEKDAYS_FULL[date.getDay()]}, ${date.getDate()} ${MONTHS_GEN[date.getMonth()]} ${date.getFullYear()}`;
    dayTitle.textContent = label.charAt(0).toUpperCase() + label.slice(1);

    const dayEntries = sortedDayEntries(iso);
    const left = dayEntries.filter((entry) => !entry.done).length;

    dayCount.textContent = dayEntries.length
      ? `${dayEntries.length} ${plural(dayEntries.length, ["запись", "записи", "записей"])} · не выполнено: ${left}`
      : "";

    entryList.innerHTML = "";
    emptyState.hidden = dayEntries.length !== 0;

    const template = document.getElementById("entryTemplate");
    for (const entry of dayEntries) {
      const node = template.content.firstElementChild.cloneNode(true);
      node.dataset.id = entry.id;
      if (entry.done) node.classList.add("entry--done");

      const check = node.querySelector(".entry__check");
      check.setAttribute("aria-pressed", String(entry.done));
      check.addEventListener("click", () => toggleDone(entry.id));

      node.querySelector(".entry__time").textContent = entry.time || "";
      node.querySelector(".entry__title").textContent = entry.title;
      node.querySelector(".entry__note").textContent = entry.note || "";

      const meta = node.querySelector(".entry__meta");
      if (entry.repeat !== "none") {
        meta.appendChild(makeTag(`🔁 ${REPEAT_LABELS[entry.repeat]}`));
      }
      if (entry.remind) {
        meta.appendChild(
          makeTag(`🔔 ${entry.time || DEFAULT_TIME}`, "remind"),
        );
      }

      node.querySelector(".entry__edit").addEventListener("click", () => openDialog(entry));
      node.querySelector(".entry__delete").addEventListener("click", () => deleteEntry(entry.id));

      entryList.appendChild(node);
    }
  }

  function updateHeader() {
    const iso = todayISO();
    const today = entries.filter((entry) => entry.date === iso);
    const left = today.filter((entry) => !entry.done).length;
    headerSubtitle.textContent = today.length
      ? `Сегодня: ${today.length} ${plural(today.length, ["запись", "записи", "записей"])}, не выполнено: ${left}`
      : "Планы, дела и напоминания";
  }

  function renderAll() {
    renderCalendar();
    renderDay();
    updateHeader();
  }

  // ------------------------------------------------------------- операции

  function toggleDone(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    entry.done = !entry.done;
    saveEntries();
    syncNativeSchedules();
    renderAll();
  }

  function deleteEntry(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    if (!window.confirm(`Удалить запись «${entry.title}»?`)) return;
    entries = entries.filter((item) => item.id !== id);
    saveEntries();
    syncNativeSchedules();
    renderAll();
    toast("Запись удалена");
  }

  // -------------------------------------------------------------- диалог

  const dialog = document.getElementById("entryDialog");
  const form = document.getElementById("entryForm");
  const dialogTitle = document.getElementById("dialogTitle");
  const fieldDate = document.getElementById("fieldDate");
  const fieldTime = document.getElementById("fieldTime");
  const fieldTitle = document.getElementById("fieldTitle");
  const fieldNote = document.getElementById("fieldNote");
  const fieldRepeat = document.getElementById("fieldRepeat");
  const fieldRemind = document.getElementById("fieldRemind");
  const remindHint = document.getElementById("remindHint");
  let editingId = null;

  function updateRemindHint() {
    if (!fieldRemind.checked) {
      remindHint.textContent = "";
      return;
    }
    const time = fieldTime.value || DEFAULT_TIME;
    if (isNative() && !localNotifications()) {
      remindHint.textContent = "Нативный плагин уведомлений не найден — будет использован веб-вариант.";
      return;
    }
    if (!isNative() && webNotificationsSupported() && Notification.permission !== "granted") {
      remindHint.textContent = `Напомним в ${time}. Разрешите уведомления кнопкой «Уведомления» в шапке.`;
      return;
    }
    remindHint.textContent = `Напомним в ${time}.`;
  }

  function openDialog(entry) {
    editingId = entry ? entry.id : null;
    dialogTitle.textContent = entry ? "Изменить запись" : "Новая запись";

    fieldDate.value = entry ? entry.date : state.selectedDate;
    fieldTime.value = entry ? entry.time : "";
    fieldTitle.value = entry ? entry.title : "";
    fieldNote.value = entry ? entry.note : "";
    fieldRepeat.value = entry ? entry.repeat : "none";
    fieldRemind.checked = entry ? entry.remind : false;

    updateRemindHint();
    dialog.showModal();
    fieldTitle.focus();
  }

  fieldRemind.addEventListener("change", () => {
    if (fieldRemind.checked && !fieldTime.value) fieldTime.value = DEFAULT_TIME;
    updateRemindHint();
  });
  fieldTime.addEventListener("input", updateRemindHint);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const title = fieldTitle.value.trim();
    if (!title) return;

    const date = fieldDate.value || state.selectedDate;
    const time = fieldTime.value || "";
    const note = fieldNote.value.trim();
    const repeat = REPEATS.includes(fieldRepeat.value) ? fieldRepeat.value : "none";
    const remind = fieldRemind.checked;

    if (editingId) {
      const entry = entries.find((item) => item.id === editingId);
      if (entry) {
        Object.assign(entry, { date, time, note, repeat, remind, title });
        entry.lastNotified = null;
      }
    } else {
      entries.push(
        normalizeEntry({
          id: uid(),
          date,
          time,
          title,
          note,
          repeat,
          remind,
          createdAt: Date.now(),
        }),
      );
    }

    saveEntries();
    syncNativeSchedules();
    selectDate(date);
    dialog.close();
    toast(editingId ? "Запись обновлена" : "Запись добавлена");
    editingId = null;
  });

  document.getElementById("cancelBtn").addEventListener("click", () => dialog.close());
  document.getElementById("addBtn").addEventListener("click", () => openDialog(null));

  // ------------------------------------------------------ навигация по месяцам

  document.getElementById("prevMonth").addEventListener("click", () => {
    state.viewMonth = new Date(
      state.viewMonth.getFullYear(),
      state.viewMonth.getMonth() - 1,
      1,
    );
    renderCalendar();
  });

  document.getElementById("nextMonth").addEventListener("click", () => {
    state.viewMonth = new Date(
      state.viewMonth.getFullYear(),
      state.viewMonth.getMonth() + 1,
      1,
    );
    renderCalendar();
  });

  document.getElementById("todayBtn").addEventListener("click", () => selectDate(todayISO()));

  monthTitle.addEventListener("click", () => selectDate(todayISO()));

  // ------------------------------------------------------------ уведомления UI

  const notifyBtn = document.getElementById("notifyBtn");
  const notifyBtnLabel = document.getElementById("notifyBtnLabel");

  function updateNotifyLabel() {
    if (isNative()) {
      notifyBtnLabel.textContent = "Уведомления";
      return;
    }
    if (!webNotificationsSupported()) {
      notifyBtnLabel.textContent = "Нет поддержки";
      return;
    }
    if (Notification.permission === "granted") notifyBtnLabel.textContent = "Проверить";
    else if (Notification.permission === "denied") notifyBtnLabel.textContent = "Запрещены";
    else notifyBtnLabel.textContent = "Уведомления";
  }

  notifyBtn.addEventListener("click", async () => {
    const ok = await ensureNotificationPermission();
    updateNotifyLabel();
    if (!ok) {
      toast("Уведомления запрещены. Разрешите их в настройках браузера или телефона.");
      return;
    }
    await showReminder(
      {
        id: `test-${Date.now()}`,
        title: "Ежедневник",
        note: "Уведомления работают. Напоминания придут в указанное время.",
        time: fieldTime.value || DEFAULT_TIME,
        date: todayISO(),
      },
      new Date(),
    );
    toast("Тестовое уведомление отправлено");
  });

  // ------------------------------------------------------------ экспорт/импорт

  document.getElementById("exportBtn").addEventListener("click", () => {
    const payload = {
      app: "ежедневник",
      version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ежедневник-${todayISO()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("Резервная копия сохранена");
  });

  const importInput = document.getElementById("importInput");
  document.getElementById("importBtn").addEventListener("click", () => importInput.click());

  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(incoming)) throw new Error("Неверный формат файла");

      const known = new Set(entries.map((entry) => entry.id));
      let added = 0;
      for (const raw of incoming) {
        const entry = normalizeEntry(raw || {});
        if (known.has(entry.id)) continue;
        entries.push(entry);
        known.add(entry.id);
        added += 1;
      }

      saveEntries();
      syncNativeSchedules();
      renderAll();
      toast(added ? `Импортировано записей: ${added}` : "Новых записей не найдено");
    } catch (err) {
      console.error(err);
      toast("Не удалось прочитать файл. Нужен JSON из экспорта.");
    }
  });

  // ------------------------------------------------------- установка PWA

  const installBtn = document.getElementById("installBtn");
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installBtn.hidden = false;
  });

  installBtn.addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
      toast(
        choice && choice.outcome === "accepted"
          ? "Устанавливаем приложение…"
          : "Установка отменена",
      );
      return;
    }
    // Установка недоступна автоматически — подсказываем ручной путь.
    toast(
      "Чтобы установить: откройте меню браузера «⋮» и выберите «Установить приложение» " +
        "(в Chrome на Android — «Добавить на главный экран»).",
    );
  });

  function updateInstallButton() {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (standalone) {
      installBtn.hidden = true;
      deferredPrompt = null;
    }
  }

  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
    deferredPrompt = null;
    toast("Приложение установлено");
  });

  // ------------------------------------------------------------- запуск

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) {
      console.info("Service worker требует http(s); при открытии через file:// офлайн-режим недоступен.");
      return;
    }
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("Service worker не зарегистрирован:", err);
    });
  }

  function init() {
    loadState();
    renderAll();
    updateNotifyLabel();
    updateInstallButton();
    registerServiceWorker();
    startScheduler();
    syncNativeSchedules();
  }

  let schedulerTimer = null;

  function startScheduler() {
    checkReminders();
    window.clearInterval(schedulerTimer);
    schedulerTimer = window.setInterval(checkReminders, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkReminders();
    });
  }

  init();
})();
