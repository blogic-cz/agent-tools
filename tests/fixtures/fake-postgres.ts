const [portArg, startupParamsPath, attemptsPath, vpnReadyPath] = process.argv.slice(2);

const encoder = new TextEncoder();

const frame = (type: string, payload: Uint8Array) => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, 4 + payload.length);
  out.set(payload, 5);
  return out;
};

const cString = (value: string) => encoder.encode(`${value}\0`);

const concat = (parts: Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const authenticationOk = () => {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, 0);
  return frame("R", payload);
};

const readyForQuery = () => frame("Z", encoder.encode("I"));

const errorResponse = (message: string) =>
  frame(
    "E",
    concat([cString(`SERROR`), cString(`C08006`), cString(`M${message}`), new Uint8Array([0])]),
  );

const rowDescription = (columnName: string, typeOid: number) => {
  const name = cString(columnName);
  const payload = new Uint8Array(2 + name.length + 18);
  const view = new DataView(payload.buffer);
  view.setUint16(0, 1);
  payload.set(name, 2);
  const offset = 2 + name.length;
  view.setUint32(offset, 0);
  view.setUint16(offset + 4, 0);
  view.setUint32(offset + 6, typeOid);
  view.setInt16(offset + 10, -1);
  view.setInt32(offset + 12, -1);
  view.setUint16(offset + 16, 0);
  return frame("T", payload);
};

const dataRow = (value: string) => {
  const bytes = encoder.encode(value);
  const payload = new Uint8Array(2 + 4 + bytes.length);
  const view = new DataView(payload.buffer);
  view.setUint16(0, 1);
  view.setUint32(2, bytes.length);
  payload.set(bytes, 6);
  return frame("D", payload);
};

const commandComplete = (tag: string) => frame("C", cString(tag));

const bumpAttempts = async () => {
  const file = Bun.file(attemptsPath);
  const current = (await file.exists()) ? Number.parseInt(await file.text(), 10) || 0 : 0;
  await Bun.write(attemptsPath, String(current + 1));
};

const vpnGateOpen = async () =>
  !vpnReadyPath || vpnReadyPath.length === 0 || (await Bun.file(vpnReadyPath).exists());

type SessionState = { buffer: Uint8Array; handshakeDone: boolean; readOnly: boolean };

const sessions = new WeakMap<object, SessionState>();

Bun.listen({
  hostname: "127.0.0.1",
  port: Number(portArg),
  socket: {
    open(socket) {
      sessions.set(socket, { buffer: new Uint8Array(0), handshakeDone: false, readOnly: false });
    },
    async data(socket, chunk) {
      const state = sessions.get(socket);
      if (!state) return;

      state.buffer = concat([state.buffer, chunk]);

      if (!state.handshakeDone) {
        if (state.buffer.length < 4) return;
        const startupLength = new DataView(state.buffer.buffer, state.buffer.byteOffset).getUint32(
          0,
        );
        if (state.buffer.length < startupLength) return;

        const params = new TextDecoder()
          .decode(state.buffer.slice(8, startupLength))
          .split("\0")
          .filter((part) => part.length > 0);
        await Bun.write(startupParamsPath, params.join(","));
        await bumpAttempts();
        const readOnlyIndex = params.indexOf("default_transaction_read_only");
        state.readOnly = readOnlyIndex !== -1 && params[readOnlyIndex + 1] === "on";
        state.buffer = state.buffer.slice(startupLength);
        state.handshakeDone = true;

        if (!(await vpnGateOpen())) {
          socket.write(errorResponse("connection requires VPN"));
          socket.end();
          return;
        }

        socket.write(concat([authenticationOk(), readyForQuery()]));
      }

      while (state.buffer.length >= 5) {
        const view = new DataView(state.buffer.buffer, state.buffer.byteOffset);
        const length = view.getUint32(1);
        if (state.buffer.length < length + 1) return;

        const type = String.fromCharCode(state.buffer[0]);
        const body = new TextDecoder().decode(state.buffer.slice(5, length + 1));
        state.buffer = state.buffer.slice(length + 1);

        if (type === "X") {
          socket.end();
          return;
        }

        if (type === "Q") {
          if (/^\s*insert/i.test(body)) {
            socket.write(concat([commandComplete("INSERT 0 2"), readyForQuery()]));
            continue;
          }

          const response = body.includes("transaction_read_only")
            ? concat([
                rowDescription("transaction_read_only", 25),
                dataRow(state.readOnly ? "on" : "off"),
              ])
            : concat([rowDescription("ok", 23), dataRow("1")]);
          socket.write(concat([response, commandComplete("SELECT 1"), readyForQuery()]));
        }
      }
    },
  },
});
