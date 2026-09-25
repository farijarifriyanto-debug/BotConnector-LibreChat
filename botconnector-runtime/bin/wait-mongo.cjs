const net = require("net");
const host = process.env.LIBRECHAT_MONGO_WAIT_HOST || "127.0.0.1";
const port = Number(process.env.LIBRECHAT_MONGO_WAIT_PORT || "27019");
let tries = 0;
function probe() {
  const s = net.createConnection({ host, port });
  let settled = false;
  const done = (ok) => {
    if (settled) return;
    settled = true;
    s.destroy();
    if (ok) process.exit(0);
    tries += 1;
    if (tries >= 60) {
      console.error("MongoDB is not reachable at " + host + ":" + port);
      process.exit(1);
    }
    setTimeout(probe, 1000);
  };
  s.setTimeout(1000, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
}
probe();
