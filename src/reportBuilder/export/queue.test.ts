import { describe, it, expect } from "vitest";
import { SingleSlot, ExportBusyError } from "./queue.js";

const deferred = () => {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("SingleSlot", () => {
  it("runs a task and returns what it returns", async () => {
    const slot = new SingleSlot();

    expect(await slot.run(async () => "listo")).toBe("listo");
    expect(slot.isBusy).toBe(false);
  });

  it("refuses a second task while the first is running", async () => {
    // A silent wait behind a two-minute export looks exactly like a frozen
    // system. Refusing with a sentence beats a place in an invisible queue.
    const slot = new SingleSlot();
    const first = deferred();
    const running = slot.run(() => first.promise);

    await expect(slot.run(async () => "segundo")).rejects.toBeInstanceOf(ExportBusyError);

    first.resolve("primero");
    expect(await running).toBe("primero");
  });

  it("frees the slot after a task fails", async () => {
    const slot = new SingleSlot();

    await expect(slot.run(async () => { throw new Error("falló"); })).rejects.toThrow("falló");

    expect(slot.isBusy).toBe(false);
    expect(await slot.run(async () => "el siguiente pasa")).toBe("el siguiente pasa");
  });

  it("reports being busy only while a task is in flight", async () => {
    const slot = new SingleSlot();
    const task = deferred();
    const running = slot.run(() => task.promise);

    expect(slot.isBusy).toBe(true);
    task.resolve("hecho");
    await running;
    expect(slot.isBusy).toBe(false);
  });

  it("carries a message written for the person reading it", async () => {
    const slot = new SingleSlot();
    const task = deferred();
    const running = slot.run(() => task.promise);

    // `rejects`, not `.catch(cb)`: with a callback, a `run` that resolved
    // instead of rejecting would skip the assertion and the test would pass
    // having checked nothing.
    await expect(slot.run(async () => "x")).rejects.toThrow(/exportación en curso/);

    task.resolve("hecho");
    await running;
  });
});
