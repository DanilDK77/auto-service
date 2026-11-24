/*
 * ГАРАЖ 77 — локальный сервер + база данных SQLite
 * -------------------------------------------------
 * Раздаёт сайт япония1.html на http://localhost:3000 и обслуживает
 * весь API (/api/*), который фронтенд уже ожидает через слой Api.call().
 *
 * Запуск:  node server.js        (или npm start)
 * Зависимости: только встроенные модули Node.js >= 22.5 (node:sqlite).
 * База создаётся автоматически в ./db/garage77.db при первом запуске.
 */

// В node:sqlite экспериментальный — глушим предупреждение, чтобы консоль была чистой.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w && w.name === "ExperimentalWarning") return;
  console.warn(w && w.name ? w.name + ": " + w.message : w);
});

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

/* ============================== КОНФИГ ============================== */
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DB_DIR = path.join(ROOT, "db");
const DB_FILE = path.join(DB_DIR, "garage77.db");
const INDEX_FILE = path.join(ROOT, "япония1.html");
const MAX_BODY = 25 * 1024 * 1024; // 25 МБ — на загрузку фото в base64

/* ============================== БАЗА ДАННЫХ ============================== */
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tag  TEXT,
  descr TEXT
);
CREATE TABLE IF NOT EXISTS prices (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  cat   TEXT,
  time  INTEGER,
  price INTEGER
);
CREATE TABLE IF NOT EXISTS reviews (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  who   TEXT, car TEXT, stars INTEGER, date TEXT, text TEXT
);
CREATE TABLE IF NOT EXISTS stats (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  n      INTEGER, suffix TEXT, l TEXT, k TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL,
  phone TEXT,
  email TEXT NOT NULL UNIQUE,
  pass  TEXT NOT NULL,
  role  TEXT NOT NULL DEFAULT 'client'
);
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS orders (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  phone   TEXT,
  car     TEXT,
  plate   TEXT,
  svc     TEXT,
  price   INTEGER DEFAULT 0,
  time    INTEGER DEFAULT 0,
  date    TEXT,
  slot    TEXT,
  status  TEXT DEFAULT 'new',
  email   TEXT,
  comment TEXT,
  created TEXT,
  post    INTEGER
);
CREATE TABLE IF NOT EXISTS order_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  ts       TEXT,
  text     TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS photos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  caption  TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS blobs (
  filename TEXT PRIMARY KEY,
  mime     TEXT,
  data     TEXT
);
`);

/* ============================== КОНСТАНТЫ (как на фронтенде) ============================== */
const SLOT_TIMES = ["08:00","09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00"];
const ST = {
  new:     { l: "Новая",        j: "新" },
  confirm: { l: "Подтверждена", j: "確" },
  work:    { l: "В работе",     j: "工" },
  done:    { l: "Выдана",       j: "完" },
  cancel:  { l: "Отменена",     j: "止" }
};
const FLOW = ["new", "confirm", "work", "done"];
const PLATE_RU = { A:"А", B:"В", E:"Е", K:"К", M:"М", H:"Н", O:"О", P:"Р", C:"С", T:"Т", Y:"У", X:"Х" };
const PLATE_LETTERS = "АВЕКМНОРСТУХ";

/* ============================== УТИЛИТЫ ============================== */
const pad2 = (n) => (n < 10 ? "0" : "") + n;
function stampNow(d) {
  const n = d || new Date();
  return pad2(n.getDate()) + "." + pad2(n.getMonth() + 1) + " " + pad2(n.getHours()) + ":" + pad2(n.getMinutes());
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}
function hexId() { return crypto.randomBytes(16).toString("hex"); }
function phoneDigits(v) {
  let d = String(v == null ? "" : v).replace(/\D/g, "");
  if (d.length && d[0] === "8") d = "7" + d.slice(1);
  if (d.length && d[0] !== "7") d = "7" + d;
  return d.slice(0, 11);
}
function maskPlate(v) {
  const chars = String(v || "").toUpperCase().split("").map((c) => PLATE_RU[c] || c);
  let i = 0;
  const take = (kind, max) => {
    let s = "";
    while (i < chars.length && s.length < max) {
      const c = chars[i]; i++;
      const isL = PLATE_LETTERS.indexOf(c) >= 0, isD = c >= "0" && c <= "9";
      if ((kind === "L" && isL) || (kind === "D" && isD)) s += c;
    }
    return s;
  };
  const a = take("L", 1); if (!a) return "";
  const b = take("D", 3);
  const c = take("L", 2);
  const d = take("D", 3);
  return a + b + c + (d ? " " + d : "");
}
const validName  = (v) => /^[А-Яа-яЁёA-Za-z\s-]{2,60}$/.test(String(v || "").trim());
const validPhone = (v) => phoneDigits(v).length === 11;
const validEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || "").trim());
const validPlate = (v) => !String(v || "").trim() ||
  /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/.test(String(v).replace(/\s/g, ""));

// Ошибка с HTTP-статусом и (опционально) полями формы — фронт читает error.status / error.fields.
function apiError(status, message, fields) {
  const e = new Error(message);
  e.status = status;
  e.fields = fields || null;
  return e;
}

/* ============================== ДЕМО-ФОТО (для фотоотчёта) ============================== */
function demoPhoto(kind, kanji, label, accent) {
  const lift = kind === 1 ? 300 : kind === 3 ? 330 : 316;
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='480' viewBox='0 0 640 480'>" +
    "<defs><linearGradient id='bg' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#1B1830'/><stop offset='1' stop-color='#0A0910'/></linearGradient>" +
    "<radialGradient id='lamp' cx='.5' cy='.2'><stop offset='0' stop-color='#F0A93B' stop-opacity='.55'/><stop offset='1' stop-color='#F0A93B' stop-opacity='0'/></radialGradient></defs>" +
    "<rect width='640' height='480' fill='url(#bg)'/>" +
    "<circle cx='470' cy='120' r='84' fill='" + accent + "' opacity='.22'/>" +
    "<ellipse cx='320' cy='150' rx='240' ry='120' fill='url(#lamp)'/>" +
    "<g stroke='#E8C36B' stroke-opacity='.35' fill='none'><path d='M60 96h520M84 96v330M556 96v330'/><path d='M50 88q270 -26 540 0'/></g>" +
    "<rect x='120' y='150' width='400' height='250' fill='#0E0C18' stroke='#E8C36B' stroke-opacity='.25'/>" +
    "<g fill='#2A2740'><rect x='170' y='" + (lift + 10) + "' width='12' height='" + (400 - lift) + "'/><rect x='458' y='" + (lift + 10) + "' width='12' height='" + (400 - lift) + "'/></g>" +
    "<g transform='translate(0," + (lift - 316) + ")'>" +
    "<path d='M204 382l6-24q8-16 30-20l38-24q34-14 74-8l52 22q28 6 38 22l6 32z' fill='#3B3550' stroke='" + accent + "' stroke-opacity='.7'/>" +
    "<path d='M252 340l26-18q26-10 54-6l30 16z' fill='#6E7BA8' opacity='.7'/>" +
    "<circle cx='254' cy='384' r='21' fill='#15121F' stroke='#E8C36B' stroke-opacity='.5'/><circle cx='394' cy='384' r='21' fill='#15121F' stroke='#E8C36B' stroke-opacity='.5'/>" +
    "<circle cx='254' cy='384' r='8' fill='#E8C36B' opacity='.6'/><circle cx='394' cy='384' r='8' fill='#E8C36B' opacity='.6'/></g>" +
    "<rect x='0' y='400' width='640' height='80' fill='#0A0910'/><path d='M0 400h640' stroke='#E8C36B' stroke-opacity='.3'/>" +
    "<text x='40' y='72' font-family='serif' font-size='46' fill='" + accent + "' opacity='.9'>" + kanji + "</text>" +
    "<text x='40' y='448' font-family='sans-serif' font-size='19' fill='#EFE6DA'>" + label + "</text>" +
    "<text x='600' y='448' font-family='monospace' font-size='14' fill='#E8C36B' text-anchor='end'>GARAGE77 / PHOTO</text>" +
    "</svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

/* ============================== НАЧАЛЬНЫЕ ДАННЫЕ (seed) ============================== */
const SEED_SERVICES = [
  { id:"diag", name:"Диагностика", tag:"01", desc:"Компьютерная диагностика всех систем, чтение ошибок, эндоскопия, проверка на стенде. Отчёт в PDF." },
  { id:"engine", name:"Двигатель и КПП", tag:"02", desc:"От замены ремня до капитального ремонта. Дефектовка, расточка, сборка с моментной затяжкой." },
  { id:"oil", name:"ТО и жидкости", tag:"03", desc:"Масло, фильтры, антифриз, тормозная жидкость. Регламент завода-изготовителя, отметка в сервисной книжке." },
  { id:"brakes", name:"Тормоза и подвеска", tag:"04", desc:"Колодки, диски, суппорты, сайлентблоки, амортизаторы. Развал-схождение на 3D-стенде." },
  { id:"electric", name:"Электрика", tag:"05", desc:"Проводка, генераторы, стартеры, сигнализации, свет. Поиск утечек тока тепловизором." },
  { id:"body", name:"Кузов и покраска", tag:"06", desc:"Локальный ремонт, стапель, покраска в камере, полировка. Подбор краски по спектрофотометру." },
  { id:"trans", name:"АКПП и вариаторы", tag:"07", desc:"Замена масла, ремонт гидроблока, восстановление вариаторов. Проверка давления и адаптация после ремонта." },
  { id:"air", name:"Кондиционер и климат", tag:"08", desc:"Заправка фреоном, поиск утечек ультрафиолетом, ремонт компрессора, антибактериальная обработка." },
  { id:"tires", name:"Шиномонтаж и диски", tag:"09", desc:"Сезонная переобувка, балансировка, правка литых дисков, ремонт бескамерных, сезонное хранение." },
  { id:"glass", name:"Стёкла и оптика", tag:"10", desc:"Замена лобовых и боковых стёкол, ремонт сколов, полировка фар, коррекция света по ГОСТу." },
  { id:"exhaust", name:"Выхлопная система", tag:"11", desc:"Замена катализаторов, пламегасителей, гофр и глушителей. Полировка нержавейки, обманки датчиков." },
  { id:"merge", name:"Проверка перед покупкой", tag:"12", desc:"Комплексный осмотр донора: толщиномер, сканер, подъёмник, проверка истории. Отчёт за час." },
  { id:"detail", name:"Детейлинг и химчистка", tag:"13", desc:"Химчистка салона, полировка кузова, керамика и защитные составы, озонирование, чернение резины." },
  { id:"road", name:"Техпомощь и эвакуатор", tag:"14", desc:"Выезд по городу и трассе: пуск двигателя, подвоз жидкостей, снятие с сигнализации, погрузка и эвакуация." }
];
const SEED_PRICES = [
  [1,"Компьютерная диагностика","Диагностика",40,1500],[2,"Диагностика подвески","Диагностика",30,900],
  [3,"Замена масла ДВС + фильтр","ТО и жидкости",40,800],[4,"Замена масла АКПП (частичная)","ТО и жидкости",60,2200],
  [5,"Замена воздушного фильтра","ТО и жидкости",20,300],[6,"Замена тормозных колодок (ось)","Тормоза и подвеска",60,1400],
  [7,"Замена тормозных дисков + колодки","Тормоза и подвеска",120,2800],[8,"Развал-схождение 3D","Тормоза и подвеска",60,1900],
  [9,"Замена амортизатора (шт.)","Тормоза и подвеска",90,1800],[10,"Замена ремня ГРМ","Двигатель и КПП",240,6500],
  [11,"Замена свечей зажигания","Двигатель и КПП",45,900],[12,"Капитальный ремонт ДВС","Двигатель и КПП",2880,45000],
  [13,"Поиск утечки тока","Электрика",90,1600],[14,"Ремонт генератора","Электрика",150,3200],
  [15,"Установка сигнализации","Электрика",240,4500],[16,"Покраска элемента кузова","Кузов и покраска",480,7500],
  [17,"Полировка кузова","Кузов и покраска",360,5500],[18,"Ремонт скола / трещины стекла","Кузов и покраска",45,1200],
  [19,"Замена масла в АКПП (полная, аппарат)","АКПП и вариаторы",120,3800],[20,"Ремонт гидроблока АКПП","АКПП и вариаторы",480,18000],
  [21,"Адаптация АКПП после ремонта","АКПП и вариаторы",60,2400],[22,"Заправка кондиционера R-134a","Кондиционер и климат",60,2200],
  [23,"Поиск утечки фреона (ультрафиолет)","Кондиционер и климат",90,1800],[24,"Антибактериальная обработка климата","Кондиционер и климат",40,1400],
  [25,"Сезонная переобувка (комплект)","Шиномонтаж и диски",90,2600],[26,"Балансировка колеса","Шиномонтаж и диски",20,500],
  [27,"Правка литого диска","Шиномонтаж и диски",60,2500],[28,"Сезонное хранение шин","Шиномонтаж и диски",30,3500],
  [29,"Замена лобового стекла","Стёкла и оптика",150,4200],[30,"Полировка фар (пара)","Стёкла и оптика",90,2200],
  [31,"Коррекция света по ГОСТу","Стёкла и оптика",45,1200],[32,"Замена гофры глушителя","Выхлопная система",120,2800],
  [33,"Установка пламегасителя","Выхлопная система",240,5500],[34,"Полировка системы выпуска","Выхлопная система",180,4200],
  [35,"Проверка авто перед покупкой","Проверка перед покупкой",90,2900],[36,"Экспертиза с толщиномером и отчётом","Проверка перед покупкой",120,3900],
  [37,"Химчистка салона (комплекс)","Детейлинг и химчистка",480,9500],[38,"Полировка кузова абразивная","Детейлинг и химчистка",420,8900],
  [39,"Керамическое покрытие кузова","Детейлинг и химчистка",600,18000],[40,"Выезд техпомощи по городу","Техпомощь и эвакуатор",60,2500],
  [41,"Эвакуация до сервиса","Техпомощь и эвакуатор",90,3500],[42,"Пуск двигателя / прикуривание","Техпомощь и эвакуатор",40,1500]
];
const SEED_REVIEWS = [
  ["Иван П.","BMW 320i · замена ГРМ",5,"12.10.2026","Приехал со стуком в двигателе. За день перебрали ГРМ, прислали 14 фото в кабинет — видно каждый болт. Цена совпала со сметой до рубля."],
  ["Марина К.","Kia Rio · ТО-60000",5,"28.09.2026","Записалась онлайн ночью, утром уже подтвердили. Масло поменяли за 35 минут, кофе действительно вкусный. Сервисная книжка с отметкой."],
  ["Сергей Д.","Toyota Camry · тормоза",5,"15.09.2026","Диски и колодки по кругу. Показали старые детали, замерили новые штангенциркулем при мне. Так работают честные сервисы."],
  ["Алексей В.","VW Tiguan · электрика",4,"02.09.2026","Искали утечку тока полдня — нашли окисленный контакт в багажнике. Минус звезда за ожидание, но результат отличный."],
  ["Ольга Н.","Mazda CX-5 · покраска",5,"21.08.2026","Царапина на крыле после парковки. Подобрали краску идеально — даже на солнце не видно перехода. Гарантийный талон выдали."],
  ["Дмитрий Р.","Lada Vesta · подвеска",5,"07.08.2026","Развал-схождение на 3D-стенде, распечатка до/после. Машину перестало тянуть вправо. Вернусь на зимнее ТО."]
];
const SEED_STATS = [
  [14, null, "лет на рынке", "年"],
  [48210, null, "закрытых заказ-нарядов", "件"],
  [87, "%", "клиентов возвращаются", "客"],
  [8, null, "подъёмников", "台"]
];
const DEMO_PHOTOS = {
  "demo-01-priemka.svg": demoPhoto(1, "受", "Приёмка автомобиля · пост №4", "#E2483D"),
  "demo-02-defektovka.svg": demoPhoto(2, "検", "Дефектовка · замер узлов", "#4EA8FF"),
  "demo-03-raboty.svg": demoPhoto(3, "工", "Выполненные работы · моментная затяжка", "#F0A93B"),
  "demo-04-stend.svg": demoPhoto(4, "完", "Проверка на стенде · готово к выдаче", "#63C08A")
};

function seedIfNeeded() {
  const hasCatalog = db.prepare("SELECT COUNT(*) AS c FROM prices").get().c > 0;
  if (!hasCatalog) {
    const insSvc = db.prepare("INSERT INTO services (id, name, tag, descr) VALUES (?, ?, ?, ?)");
    SEED_SERVICES.forEach((s) => insSvc.run(s.id, s.name, s.tag, s.desc));
    const insPrice = db.prepare("INSERT INTO prices (id, name, cat, time, price) VALUES (?, ?, ?, ?, ?)");
    SEED_PRICES.forEach((p) => insPrice.run(p[0], p[1], p[2], p[3], p[4]));
    const insRev = db.prepare("INSERT INTO reviews (who, car, stars, date, text) VALUES (?, ?, ?, ?, ?)");
    SEED_REVIEWS.forEach((r) => insRev.run(r[0], r[1], r[2], r[3], r[4]));
    const insStat = db.prepare("INSERT INTO stats (n, suffix, l, k) VALUES (?, ?, ?, ?)");
    SEED_STATS.forEach((s) => insStat.run(s[0], s[1], s[2], s[3]));
    const insBlob = db.prepare("INSERT OR REPLACE INTO blobs (filename, mime, data) VALUES (?, ?, ?)");
    Object.keys(DEMO_PHOTOS).forEach((f) => insBlob.run(f, "image/svg+xml", DEMO_PHOTOS[f]));
    console.log("✓ Каталог заполнен (услуги, прайс, отзывы, статистика, демо-фото).");
  }

  const hasUsers = db.prepare("SELECT COUNT(*) AS c FROM users").get().c > 0;
  if (!hasUsers) {
    const insUser = db.prepare("INSERT INTO users (id, name, phone, email, pass, role) VALUES (?, ?, ?, ?, ?, ?)");
    insUser.run(1, "Администратор", "+74957777777", "admin@garage77.ru", "admin123", "admin");
    insUser.run(2, "Иван Петров", "+79001234567", "ivan@mail.ru", "client123", "client");
    console.log("✓ Созданы пользователи: admin@garage77.ru / admin123, ivan@mail.ru / client123.");
  }

  const hasOrders = db.prepare("SELECT COUNT(*) AS c FROM orders").get().c > 0;
  if (!hasOrders) {
    const SEED_ORDERS = [
      { id:1042, name:"Иван Петров", phone:"+79001234567", car:"BMW 320i", plate:"А123ВС 38", svc:"Замена ремня ГРМ", price:6500, time:240,
        date:"2026-11-20", slot:"10:00", status:"done", email:"ivan@mail.ru", comment:"Стук при холодном пуске", created:"2026-11-18T09:12:00", post:4,
        log:[["18.11 09:12","Заявка создана"],["18.11 09:25","Подтверждена администратором"],["20.11 10:04","Принята в работу, пост №4"],["20.11 16:40","Работы завершены, выдана"]],
        photos:[["demo-01-priemka.svg","Приёмка автомобиля"],["demo-02-defektovka.svg","Дефектовка"],["demo-03-raboty.svg","Выполненные работы"],["demo-04-stend.svg","Проверка на стенде"]] },
      { id:1043, name:"Иван Петров", phone:"+79001234567", car:"BMW 320i", plate:"А123ВС 38", svc:"Замена масла ДВС + фильтр", price:800, time:40,
        date:"2026-11-24", slot:"09:00", status:"confirm", email:"ivan@mail.ru", comment:"Масло своё, 5W-30", created:"2026-11-21T18:40:00", post:null,
        log:[["21.11 18:40","Заявка создана"],["21.11 18:52","Подтверждена администратором"]], photos:[] },
      { id:1044, name:"Марина Козлова", phone:"+79005553535", car:"Kia Rio", plate:"В777ОР 38", svc:"Развал-схождение 3D", price:1900, time:60,
        date:"2026-11-22", slot:"12:00", status:"work", email:"", comment:"Тянет вправо после ямы", created:"2026-11-21T11:05:00", post:2,
        log:[["21.11 11:05","Заявка создана"],["21.11 11:15","Подтверждена"],["22.11 12:02","В работе, пост №2"]],
        photos:[["demo-01-priemka.svg","Приёмка автомобиля"],["demo-02-defektovka.svg","Дефектовка"]] },
      { id:1045, name:"Сергей Дронов", phone:"+79008881122", car:"Toyota Camry", plate:"Е001КХ 138", svc:"Замена тормозных дисков + колодки", price:2800, time:120,
        date:"2026-11-23", slot:"14:00", status:"new", email:"", comment:"", created:"2026-11-22T08:15:00", post:null,
        log:[["22.11 08:15","Заявка создана"]], photos:[] }
    ];
    const insOrder = db.prepare(`INSERT INTO orders (id, name, phone, car, plate, svc, price, time, date, slot, status, email, comment, created, post)
      VALUES (@id, @name, @phone, @car, @plate, @svc, @price, @time, @date, @slot, @status, @email, @comment, @created, @post)`);
    const insLog = db.prepare("INSERT INTO order_logs (order_id, ts, text) VALUES (?, ?, ?)");
    const insPhoto = db.prepare("INSERT INTO photos (order_id, filename, caption) VALUES (?, ?, ?)");
    SEED_ORDERS.forEach((o) => {
      insOrder.run({ id: o.id, name: o.name, phone: o.phone, car: o.car, plate: o.plate, svc: o.svc, price: o.price,
        time: o.time, date: o.date, slot: o.slot, status: o.status, email: o.email, comment: o.comment, created: o.created, post: o.post });
      o.log.forEach((l) => insLog.run(o.id, l[0], l[1]));
      o.photos.forEach((p) => insPhoto.run(o.id, p[0], p[1]));
    });
    console.log("✓ Созданы демо-заказ-наряды №1042–1045.");
  }
}
seedIfNeeded();

/* ============================== ДОСТУП К ДАННЫМ ============================== */
function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.phone, u.email, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  return row || null;
}
const pubUser = (u) => (u ? { id: u.id, name: u.name, phone: u.phone, email: u.email, role: u.role } : null);

function loadPhotos(orderId) {
  return db.prepare("SELECT id, filename, caption FROM photos WHERE order_id = ? ORDER BY id").all(orderId)
    .map((p) => ({ id: p.id, file: p.filename, caption: p.caption }));
}
function loadLog(orderId) {
  return db.prepare("SELECT ts, text FROM order_logs WHERE order_id = ? ORDER BY id").all(orderId)
    .map((l) => [l.ts, l.text]);
}
function outOrder(o) {
  if (!o) return null;
  return {
    id: o.id, name: o.name, phone: o.phone, car: o.car, plate: o.plate, svc: o.svc,
    price: o.price, time: o.time, date: o.date, slot: o.slot, status: o.status,
    email: o.email, comment: o.comment, created: o.created, post: o.post,
    log: loadLog(o.id), photos: loadPhotos(o.id)
  };
}
function findOrder(id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(id)) || null;
}
function addLog(orderId, text) {
  db.prepare("INSERT INTO order_logs (order_id, ts, text) VALUES (?, ?, ?)").run(orderId, stampNow(), text);
}
function ownsOrder(user, o) {
  if (!user || !o) return false;
  if (user.role === "admin") return true;
  if (o.email && user.email && String(o.email).toLowerCase() === String(user.email).toLowerCase()) return true;
  if (o.phone && user.phone && String(o.phone) === String(user.phone)) return true;
  return false;
}
function busySlots(date) {
  const rows = db.prepare("SELECT DISTINCT slot FROM orders WHERE date = ? AND status <> 'cancel'").all(date);
  return rows.map((r) => r.slot);
}
function catalog() {
  const services = db.prepare("SELECT id, name, descr AS descr, tag FROM services").all()
    .map((s) => ({ id: s.id, name: s.name, desc: s.descr, tag: s.tag }));
  const prices = db.prepare("SELECT id, name, cat, time, price FROM prices ORDER BY id").all();
  const reviews = db.prepare("SELECT who, car, stars, date, text FROM reviews ORDER BY id").all();
  const stats = db.prepare("SELECT n, suffix, l, k FROM stats ORDER BY id").all();
  return { services, prices, reviews, stats };
}

/* ============================== ВАЛИДАЦИЯ ЗАЯВКИ (серверная) ============================== */
function validateOrder(b) {
  const errors = {};
  const name = String(b.name || "").trim();
  const phone = "+" + phoneDigits(b.phone);
  const car = String(b.car || "").trim();
  const plate = maskPlate(b.plate);
  const date = String(b.date || ""), slot = String(b.slot || "");
  const comment = String(b.comment || "").trim().slice(0, 400);
  const email = String(b.email || "").trim();

  if (!validName(name)) errors.name = "Укажите имя (минимум 2 буквы)";
  if (!validPhone(phone)) errors.phone = "Телефон должен содержать 11 цифр";
  if (car.length < 2) errors.car = "Укажите марку и модель";
  if (!validPlate(plate)) errors.plate = "Формат госномера: А123ВС 38";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.date = "Выберите дату";
  else if (date < todayStr()) errors.date = "Дата в прошлом";
  if (SLOT_TIMES.indexOf(slot) < 0) errors.slot = "Выберите время из списка";

  const price = db.prepare("SELECT * FROM prices WHERE id = ?").get(Number(b.serviceId)) || null;
  if (!price) errors.serviceId = "Выберите услугу из прайса";

  return { errors, price, value: { name, phone, car, plate, date, slot, comment, email } };
}

/* ============================== API-ОБРАБОТЧИКИ ============================== */
// Каждый возвращает объект (данные) или бросает apiError(status, message, fields).
function handleApi(method, pathname, query, body, user) {
  const b = body || {};

  if (method === "GET" && pathname === "/api/health") {
    return { ok: true, db: "sqlite://" + path.relative(ROOT, DB_FILE).replace(/\\/g, "/"), time: new Date().toISOString() };
  }
  if (method === "GET" && pathname === "/api/catalog") return catalog();
  if (method === "GET" && pathname === "/api/session") return { user: pubUser(user) };

  if (method === "POST" && pathname === "/api/auth/login") {
    const email = String(b.email || "").trim().toLowerCase();
    const found = db.prepare("SELECT * FROM users WHERE lower(email) = ? AND pass = ?").get(email, String(b.pass || ""));
    if (!found) throw apiError(401, "Неверный email или пароль");
    const token = hexId();
    db.prepare("INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)").run(token, found.id, new Date().toISOString());
    return { token, user: pubUser(found) };
  }
  if (method === "POST" && pathname === "/api/auth/register") {
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const phone = "+" + String(b.phone || "").replace(/\D/g, "");
    if (name.length < 2) throw apiError(400, "Укажите имя");
    if (phone.replace(/\D/g, "").length !== 11) throw apiError(400, "Телефон должен содержать 11 цифр");
    if (!validEmail(email)) throw apiError(400, "Некорректный email");
    if (String(b.pass || "").length < 6) throw apiError(400, "Пароль минимум 6 символов");
    if (db.prepare("SELECT id FROM users WHERE lower(email) = ?").get(email)) throw apiError(409, "Email уже зарегистрирован");
    const info = db.prepare("INSERT INTO users (name, phone, email, pass, role) VALUES (?, ?, ?, ?, 'client')")
      .run(name, phone, email, String(b.pass));
    const uid = Number(info.lastInsertRowid);
    const nu = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    const token = hexId();
    db.prepare("INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)").run(token, uid, new Date().toISOString());
    return { token, user: pubUser(nu) };
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(query.get("__token") || "");
    return { ok: true };
  }

  if (method === "GET" && pathname === "/api/slots") {
    const date = query.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw apiError(400, "Некорректная дата");
    return { date, times: SLOT_TIMES.slice(), busy: busySlots(date) };
  }

  if (method === "GET" && pathname === "/api/orders") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    const rows = db.prepare("SELECT * FROM orders ORDER BY created DESC").all();
    const list = rows.filter((o) => user.role === "admin" || ownsOrder(user, o)).map(outOrder);
    return { orders: list };
  }
  if (method === "POST" && pathname === "/api/orders") {
    const v = validateOrder(b);
    if (Object.keys(v.errors).length) throw apiError(400, "Проверьте поля формы", v.errors);
    if (busySlots(v.value.date).indexOf(v.value.slot) >= 0)
      throw apiError(409, "Слот " + v.value.slot + " на " + v.value.date + " уже занят — выберите другое время");
    const email = user ? user.email : v.value.email;
    const created = new Date().toISOString();
    const info = db.prepare(`INSERT INTO orders (name, phone, car, plate, svc, price, time, date, slot, status, email, comment, created, post)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, NULL)`)
      .run(v.value.name, v.value.phone, v.value.car, v.value.plate, v.price.name, v.price.price, v.price.time,
           v.value.date, v.value.slot, email, v.value.comment, created);
    const oid = Number(info.lastInsertRowid);
    addLog(oid, "Заявка создана");
    return { order: outOrder(findOrder(oid)) };
  }

  let m;
  if ((m = /^\/api\/orders\/(\d+)$/.exec(pathname))) {
    const id = Number(m[1]);
    const o = findOrder(id);
    if (method === "GET") {
      if (!o) throw apiError(404, "Заявка не найдена");
      if (!ownsOrder(user, o)) throw apiError(403, "Нет доступа к этому заказ-наряду");
      return { order: outOrder(o), canManage: !!(user && user.role === "admin") };
    }
    if (method === "DELETE") {
      if (!user) throw apiError(401, "Требуется вход в систему");
      if (user.role !== "admin") throw apiError(403, "Только для администратора");
      if (!o) throw apiError(404, "Заявка не найдена");
      db.prepare("DELETE FROM orders WHERE id = ?").run(id);
      return { removed: outOrder({ ...o, id }) };
    }
  }
  if ((m = /^\/api\/orders\/(\d+)\/status$/.exec(pathname)) && method === "PATCH") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    if (user.role !== "admin") throw apiError(403, "Только для администратора");
    const o = findOrder(m[1]); if (!o) throw apiError(404, "Заявка не найдена");
    const s = String(b.status || "");
    if (!ST[s]) throw apiError(400, "Неизвестный статус");
    if (o.status !== s) {
      let post = o.post;
      if (s === "work" && !post) post = 1 + (o.id % 8);
      db.prepare("UPDATE orders SET status = ?, post = ? WHERE id = ?").run(s, post, o.id);
      addLog(o.id, "Статус: " + ST[s].l + " (админ)");
    }
    return { order: outOrder(findOrder(o.id)) };
  }
  if ((m = /^\/api\/orders\/(\d+)\/advance$/.exec(pathname)) && method === "POST") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    if (user.role !== "admin") throw apiError(403, "Только для администратора");
    const o = findOrder(m[1]); if (!o) throw apiError(404, "Заявка не найдена");
    const i = FLOW.indexOf(o.status);
    if (i < 0 || i >= FLOW.length - 1) throw apiError(409, "Статус уже финальный");
    const next = FLOW[i + 1];
    let post = o.post;
    if (next === "work" && !post) post = 1 + (o.id % 8);
    db.prepare("UPDATE orders SET status = ?, post = ? WHERE id = ?").run(next, post, o.id);
    addLog(o.id, "Статус: " + ST[next].l);
    return { order: outOrder(findOrder(o.id)) };
  }
  if ((m = /^\/api\/orders\/(\d+)\/cancel$/.exec(pathname)) && method === "POST") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    const o = findOrder(m[1]); if (!o) throw apiError(404, "Заявка не найдена");
    if (!ownsOrder(user, o)) throw apiError(403, "Нет доступа");
    if (o.status === "cancel" || o.status === "done") throw apiError(409, "Заявку уже нельзя отменить");
    const prev = o.status;
    db.prepare("UPDATE orders SET status = 'cancel' WHERE id = ?").run(o.id);
    addLog(o.id, user.role === "admin" ? "Заявка отменена (админ)" : "Заявка отменена клиентом");
    return { order: outOrder(findOrder(o.id)), previous: prev };
  }
  if ((m = /^\/api\/orders\/(\d+)\/uncancel$/.exec(pathname)) && method === "POST") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    const o = findOrder(m[1]); if (!o) throw apiError(404, "Заявка не найдена");
    if (!ownsOrder(user, o)) throw apiError(403, "Нет доступа");
    if (o.status !== "cancel") throw apiError(409, "Заявка не отменена");
    const back = FLOW.indexOf(b.status) >= 0 ? b.status : "new";
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(back, o.id);
    addLog(o.id, "Восстановлена (" + ST[back].l + ")");
    return { order: outOrder(findOrder(o.id)) };
  }
  if ((m = /^\/api\/orders\/(\d+)\/restore$/.exec(pathname)) && method === "POST") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    if (user.role !== "admin") throw apiError(403, "Только для администратора");
    const id = Number(m[1]);
    if (findOrder(id)) throw apiError(409, "Заявка уже существует");
    if (!b.name || !b.svc || !b.date || !b.slot) throw apiError(400, "Нет данных для восстановления");
    const status = ST[b.status] ? b.status : "new";
    db.prepare(`INSERT INTO orders (id, name, phone, car, plate, svc, price, time, date, slot, status, email, comment, created, post)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, b.name, b.phone || "", b.car || "", b.plate || "", b.svc, Number(b.price) || 0, Number(b.time) || 0,
           b.date, b.slot, status, b.email || "", b.comment || "", b.created || new Date().toISOString(), b.post || null);
    if (Array.isArray(b.log)) b.log.forEach((l) => db.prepare("INSERT INTO order_logs (order_id, ts, text) VALUES (?, ?, ?)").run(id, l[0], l[1]));
    if (Array.isArray(b.photos)) b.photos.forEach((p) => db.prepare("INSERT INTO photos (order_id, filename, caption) VALUES (?, ?, ?)").run(id, p.file, p.caption || ""));
    addLog(id, "Восстановлена (" + ST[status].l + ")");
    return { order: outOrder(findOrder(id)) };
  }
  if ((m = /^\/api\/orders\/(\d+)\/photos$/.exec(pathname)) && method === "POST") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    if (user.role !== "admin") throw apiError(403, "Только для администратора");
    const o = findOrder(m[1]); if (!o) throw apiError(404, "Заявка не найдена");
    const raw = String(b.dataUrl || "");
    const mimeMatch = /^data:(image\/[\w.+-]+);base64,/.exec(raw);
    const isSvg = raw.indexOf("data:image/svg+xml") === 0;
    if (!mimeMatch && !isSvg) throw apiError(400, "Ожидается data:image/...;base64,...");
    const mime = mimeMatch ? mimeMatch[1] : "image/svg+xml";
    const filename = "local-" + o.id + "-" + Date.now().toString(36) + "-" + hexId().slice(0, 6) + extFromMime(mime);
    db.prepare("INSERT INTO blobs (filename, mime, data) VALUES (?, ?, ?)").run(filename, mime, raw);
    const info = db.prepare("INSERT INTO photos (order_id, filename, caption) VALUES (?, ?, ?)")
      .run(o.id, filename, String(b.caption || "").slice(0, 120));
    const ph = { id: Number(info.lastInsertRowid), file: filename, caption: String(b.caption || "").slice(0, 120) };
    addLog(o.id, "Добавлено фото: " + (ph.caption || "без подписи"));
    return { photo: ph, url: raw };
  }
  if ((m = /^\/api\/orders\/(\d+)\/photos\/(\d+)$/.exec(pathname)) && method === "DELETE") {
    if (!user) throw apiError(401, "Требуется вход в систему");
    if (user.role !== "admin") throw apiError(403, "Только для администратора");
    const o = findOrder(m[1]); if (!o) throw apiError(404, "Заявка не найдена");
    const ph = db.prepare("SELECT * FROM photos WHERE order_id = ? AND id = ?").get(o.id, Number(m[2]));
    if (!ph) throw apiError(404, "Фото не найдено");
    db.prepare("DELETE FROM photos WHERE id = ?").run(ph.id);
    db.prepare("DELETE FROM blobs WHERE filename = ?").run(ph.filename);
    addLog(o.id, "Фото удалено: " + (ph.caption || ph.filename));
    return { ok: true };
  }

  throw apiError(404, "Метод API не найден: " + method + " " + pathname);
}
function extFromMime(mime) {
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" })[mime] || ".img";
}

/* ============================== HTTP-СЕРВЕР ============================== */
function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(apiError(413, "Слишком большой запрос")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(apiError(400, "Некорректный JSON")); }
    });
    req.on("error", reject);
  });
}
function serveIndex(res) {
  fs.readFile(INDEX_FILE, (err, buf) => {
    if (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Не найден файл сайта: " + path.basename(INDEX_FILE));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}
function serveBlob(res, filename) {
  const row = db.prepare("SELECT mime, data FROM blobs WHERE filename = ?").get(filename);
  if (!row) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("not found"); return; }
  // data хранится как data:URL — вырезаем полезную нагрузку.
  const comma = row.data.indexOf(",");
  const payload = row.data.slice(comma + 1);
  let buf;
  if (/;base64,/i.test(row.data.slice(0, comma + 1))) buf = Buffer.from(payload, "base64");
  else buf = Buffer.from(decodeURIComponent(payload), "utf8");
  res.writeHead(200, { "Content-Type": row.mime || "application/octet-stream", "Content-Length": buf.length, "Cache-Control": "public, max-age=31536000" });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://" + (req.headers.host || HOST));
  const pathname = decodeURIComponent(u.pathname);

  // CORS-предзапрос (на случай открытия страницы с другого адреса).
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  // API
  if (pathname.indexOf("/api/") === 0) {
    let body = null;
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT" || req.method === "DELETE") {
      try { body = await readBody(req); }
      catch (e) { return sendJson(res, e.status || 400, { error: e.message, fields: e.fields || null }); }
    }
    const auth = String(req.headers.authorization || "");
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    const user = getUserByToken(token);
    // Проксируем токен в query для logout (там он нужен как значение).
    u.searchParams.set("__token", token);
    try {
      const data = handleApi(req.method, pathname, u.searchParams, body, user);
      return sendJson(res, 200, data);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error("API 500:", req.method, pathname, e);
      return sendJson(res, status, { error: e.message || "Внутренняя ошибка сервера", fields: e.fields || null });
    }
  }

  // Фото из базы
  if (pathname.indexOf("/uploads/") === 0 && req.method === "GET") {
    return serveBlob(res, path.posix.basename(pathname));
  }

  // Страница сайта
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/япония1.html")) {
    return serveIndex(res);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 — не найдено");
});

server.listen(PORT, HOST, () => {
  const url = "http://localhost:" + PORT;
  console.log("┌──────────────────────────────────────────────────┐");
  console.log("│  ГАРАЖ 77 · локальный сервер запущен             │");
  console.log("└──────────────────────────────────────────────────┘");
  console.log("  Сайт:      " + url);
  console.log("  API health:" + url + "/api/health");
  console.log("  База:      " + DB_FILE);
  console.log("  Демо-вход: admin@garage77.ru / admin123 (админ)");
  console.log("             ivan@mail.ru / client123 (клиент)");
  console.log("  Остановка: Ctrl+C");
});

function shutdown() { try { db.close(); } catch (e) {} process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
