/*
 * Быстрая проверка API сервера ГАРАЖ 77.
 * Запускать, когда сервер уже работает: node test.js
 */
const BASE = "http://127.0.0.1:" + (process.env.PORT || 3000);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
}
async function req(method, path, { token, body } = {}) {
  const headers = { "Connection": "close" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) {}
  return { status: res.status, data };
}
function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 7);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

(async () => {
  console.log("Проверка API на " + BASE + "\n");

  let r = await req("GET", "/api/health");
  ok("health ok", r.status === 200 && r.data && r.data.ok === true, r);
  ok("health db=sqlite", r.data && /sqlite/.test(r.data.db || ""), r.data);

  r = await req("GET", "/api/catalog");
  ok("catalog services=14", r.data && r.data.services.length === 14, r.data && r.data.services.length);
  ok("catalog prices=42", r.data && r.data.prices.length === 42, r.data && r.data.prices.length);
  ok("catalog reviews=6", r.data && r.data.reviews.length === 6);
  ok("catalog stats=4", r.data && r.data.stats.length === 4);

  r = await req("POST", "/api/auth/login", { body: { email: "admin@garage77.ru", pass: "admin123" } });
  ok("login admin", r.status === 200 && r.data.token && r.data.user.role === "admin", r);
  const adminToken = r.data && r.data.token;

  r = await req("POST", "/api/auth/login", { body: { email: "admin@garage77.ru", pass: "WRONG" } });
  ok("login bad → 401", r.status === 401, r);

  r = await req("GET", "/api/session", { token: adminToken });
  ok("session admin", r.data && r.data.user && r.data.user.role === "admin", r);

  r = await req("POST", "/api/auth/register", { body: { name: "Тест Тестов", phone: "+79991234567", email: "test" + Date.now() + "@mail.ru", pass: "secret123" } });
  ok("register client", r.status === 200 && r.data.token && r.data.user.role === "client", r);
  const clientToken = r.data && r.data.token;

  const date = tomorrow();
  r = await req("GET", "/api/slots?date=" + date);
  ok("slots times=14", r.data && r.data.times.length === 14, r.data);
  ok("slots busy is array", Array.isArray(r.data && r.data.busy));

  const order = { name: "Тест Тестов", phone: "+79991234567", car: "Toyota Corolla", plate: "А123ВС 38", serviceId: 1, date, slot: "11:00", comment: "тест", email: "" };
  r = await req("POST", "/api/orders", { token: clientToken, body: order });
  ok("create order", r.status === 200 && r.data.order && r.data.order.id > 0 && r.data.order.svc === "Компьютерная диагностика", r);
  const oid = r.data && r.data.order && r.data.order.id;

  r = await req("POST", "/api/orders", { token: clientToken, body: order });
  ok("duplicate slot → 409", r.status === 409, r);

  r = await req("GET", "/api/slots?date=" + date);
  ok("slot now busy", r.data && r.data.busy.indexOf("11:00") >= 0, r.data && r.data.busy);

  r = await req("POST", "/api/orders", { token: clientToken, body: { ...order, serviceId: 999 } });
  ok("bad serviceId → 400 fields", r.status === 400 && r.data && r.data.fields && r.data.fields.serviceId, r);

  r = await req("GET", "/api/orders/" + oid, { token: clientToken });
  ok("get order detail", r.data && r.data.order && r.data.order.id === oid && r.data.canManage === false, r);

  r = await req("PATCH", "/api/orders/" + oid + "/status", { token: clientToken, body: { status: "work" } });
  ok("client cannot patch → 403", r.status === 403, r);

  r = await req("PATCH", "/api/orders/" + oid + "/status", { token: adminToken, body: { status: "confirm" } });
  ok("admin patch status", r.status === 200 && r.data.order.status === "confirm", r);

  r = await req("POST", "/api/orders/" + oid + "/advance", { token: adminToken });
  ok("advance → work + post", r.status === 200 && r.data.order.status === "work" && r.data.order.post >= 1, r);

  const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  r = await req("POST", "/api/orders/" + oid + "/photos", { token: adminToken, body: { dataUrl: tinyPng, caption: "Тест фото" } });
  ok("upload photo", r.status === 200 && r.data.photo && r.data.photo.id > 0, r);
  const pid = r.data && r.data.photo && r.data.photo.id;
  const file = r.data && r.data.photo && r.data.photo.file;

  r = await fetch(BASE + "/uploads/" + encodeURIComponent(file), { headers: { "Connection": "close" } });
  ok("photo served from /uploads", r.status === 200 && /image\/png/.test(r.headers.get("content-type") || ""), r.status);

  r = await req("GET", "/api/orders/" + oid, { token: adminToken });
  ok("order has photo", r.data && r.data.order.photos.some((p) => p.id === pid), r.data && r.data.order.photos);

  r = await req("DELETE", "/api/orders/" + oid + "/photos/" + pid, { token: adminToken });
  ok("delete photo", r.status === 200 && r.data.ok === true, r);

  r = await req("GET", "/api/orders", { token: clientToken });
  ok("client orders list", r.status === 200 && Array.isArray(r.data.orders) && r.data.orders.some((o) => o.id === oid), r.data && r.data.orders.length);

  r = await req("GET", "/api/orders", {});
  ok("orders without auth → 401", r.status === 401, r);

  r = await req("POST", "/api/orders/" + oid + "/cancel", { token: clientToken });
  ok("client cancel", r.status === 200 && r.data.order.status === "cancel" && r.data.previous === "work", r);

  r = await req("POST", "/api/orders/" + oid + "/uncancel", { token: clientToken, body: { status: "work" } });
  ok("client uncancel", r.status === 200 && r.data.order.status === "work", r);

  r = await req("DELETE", "/api/orders/" + oid, { token: adminToken });
  ok("admin delete order", r.status === 200 && r.data.removed && r.data.removed.id === oid, r);

  const snapshot = { name: "Тест Тестов", svc: "Компьютерная диагностика", price: 1500, time: 40, date, slot: "11:00", status: "work", phone: "+79991234567", car: "Toyota Corolla", plate: "А123ВС 38", email: "", comment: "тест", created: new Date().toISOString(), post: 3, log: [], photos: [] };
  r = await req("POST", "/api/orders/" + oid + "/restore", { token: adminToken, body: snapshot });
  ok("admin restore order", r.status === 200 && r.data.order && r.data.order.id === oid, r);

  r = await req("POST", "/api/auth/logout", { token: adminToken });
  ok("logout", r.status === 200 && r.data.ok === true, r);

  r = await req("GET", "/api/orders", { token: adminToken });
  ok("token revoked → 401", r.status === 401, r);

  r = await fetch(BASE + "/");
  const html = await r.text();
  ok("index html served", r.status === 200 && /ГАРАЖ 77/.test(html), r.status);

  console.log("\nИтого: " + pass + " прошло, " + fail + " упало.");
  // Завершаемся мягко (без process.exit) — со Connection: close сокеты уже закрыты,
  // иначе libuv на Windows бросает assertion при принудительном выходе.
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("Сбой теста:", e); process.exitCode = 2; });
