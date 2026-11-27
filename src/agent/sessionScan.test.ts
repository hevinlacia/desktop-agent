import { describe, expect, it } from "vitest";
import { parseSessionHead, sessionDirPath } from "./sessionScan";

describe("sessionDirPath", () => {
  it("复刻 pi 的目录命名：/ \\ : 换成 -，-- 包裹（钉住真实目录名）", () => {
    expect(sessionDirPath("/home/u/.pi/agent", "/home/hevin/Developer/company/云仓/WMS")).toBe(
      "/home/u/.pi/agent/sessions/--home-hevin-Developer-company-云仓-WMS--",
    );
    expect(sessionDirPath("/home/u/.pi/agent", "/tmp")).toBe("/home/u/.pi/agent/sessions/--tmp--");
    expect(sessionDirPath("/home/u/.pi/agent", "/home/u/a:b")).toBe("/home/u/.pi/agent/sessions/--home-u-a-b--");
  });
});

describe("parseSessionHead", () => {
  const header = '{"type":"session","version":3,"id":"aptest001","timestamp":"2026-07-08T07:35:46.521Z","cwd":"/tmp"}';
  const info = '{"type":"session_info","id":"20a5f188","name":"ap-sid-test-001"}';
  const message = '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';

  it("解析 header 与 session_info 名字", () => {
    expect(parseSessionHead([header, info, message].join("\n"))).toEqual({
      sessionId: "aptest001",
      cwd: "/tmp",
      name: "ap-sid-test-001",
      startedAtMs: Date.parse("2026-07-08T07:35:46.521Z"),
    });
  });

  it("没有名字时 name 缺省；坏行跳过", () => {
    const head = parseSessionHead(["不是json", header, "{oops", message].join("\n"));
    expect(head).toMatchObject({ sessionId: "aptest001", cwd: "/tmp" });
    expect(head?.name).toBeUndefined();
  });

  it("首行不是 session header 返回 null；缺 id/cwd 也返回 null", () => {
    expect(parseSessionHead(message)).toBeNull();
    expect(parseSessionHead('{"type":"session"}')).toBeNull();
    expect(parseSessionHead("")).toBeNull();
  });
});
