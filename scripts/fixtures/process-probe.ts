const captured = Reflect.get(Bun, "spawn");
export const attemptProcess = () => captured(["/bin/echo", "forbidden"]);
