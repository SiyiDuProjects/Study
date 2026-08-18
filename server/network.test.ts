// @vitest-environment node
import { describe, expect, it } from "vitest";
import { lectureListenHost } from "./network.js";

describe("lecture server binding", () => {
  it("keeps development API on loopback so a proxy cannot turn LAN traffic into a local owner", () => {
    expect(lectureListenHost(false)).toBe("127.0.0.1");
  });

  it("allows the production container listener while browser auth mode remains independently fail-closed", () => {
    expect(lectureListenHost(true)).toBe("0.0.0.0");
  });
});
