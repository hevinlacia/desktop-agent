import { describe, expect, it } from "vitest";
import { candidateHubUrls, fetchSessionRequirements, sessionRequirementIds, summarize } from "./panel-client";

describe("candidateHubUrls", () => {
  it("配置优先，其次内网 hub 与 tailnet 入口，去尾斜杠去重", () => {
    expect(candidateHubUrls("http://example.test/", {})).toEqual([
      "http://example.test",
      "http://192.168.6.133:8788",
      "https://edge.tail260d93.ts.net",
    ]);
  });

  it("配置为空时用 env", () => {
    expect(candidateHubUrls("", { AGENT_PANEL_URL: "http://env.test" })[0]).toBe("http://env.test");
  });

  it("配置与 env 都空时仍有两个默认候选", () => {
    expect(candidateHubUrls("  ", {})).toHaveLength(2);
  });

  it("配置与默认值相同时不重复", () => {
    expect(candidateHubUrls("http://192.168.6.133:8788", {})).toEqual([
      "http://192.168.6.133:8788",
      "https://edge.tail260d93.ts.net",
    ]);
  });
});

describe("sessionRequirementIds", () => {
  it("主需求在前，其余去重", () => {
    expect(
      sessionRequirementIds({ primaryReqId: "REQ-339", reqIds: ["REQ-338", "REQ-339"] }),
    ).toEqual(["REQ-339", "REQ-338"]);
  });

  it("没有绑定返回空数组", () => {
    expect(sessionRequirementIds({})).toEqual([]);
    expect(sessionRequirementIds(null)).toEqual([]);
  });
});

describe("summarize", () => {
  it("抽出展示字段，主需求排最前，其余按更新时间降序", () => {
    const list = summarize("REQ-1", [
      { requirement: { id: "REQ-2", title: "旧", status: "已合并", updatedAt: 1 } },
      { requirement: { id: "REQ-1", title: "主", status: "待审查", project: "desktop-agent", updatedAt: 5 } },
      { requirement: { id: "REQ-3", title: "新", status: "修复中", updatedAt: 9 } },
    ]);
    expect(list.map((r) => r.id)).toEqual(["REQ-1", "REQ-3", "REQ-2"]);
    expect(list[0]).toMatchObject({ title: "主", status: "待审查", project: "desktop-agent" });
  });

  it("脏数据被忽略（缺 id / 非对象）", () => {
    expect(summarize(undefined, [{}, { requirement: null }, { requirement: { title: "x" } }])).toEqual([]);
  });
});

describe("fetchSessionRequirements", () => {
  it("首个候选失败会换下一个", async () => {
    const calls: string[] = [];
    const bundle = await fetchSessionRequirements({
      sessionId: "s1",
      configUrl: "",
      fetchJson: async (url) => {
        calls.push(url);
        if (url.includes("192.168.6.133")) throw new Error("ECONNREFUSED");
        if (url.includes("by-session")) return { primaryReqId: "REQ-1", reqIds: [] };
        return { requirement: { id: "REQ-1", title: "t", status: "开发中" } };
      },
    });
    expect(bundle.ok).toBe(true);
    expect(bundle.hubUrl).toBe("https://edge.tail260d93.ts.net");
    expect(bundle.requirements.map((r) => r.id)).toEqual(["REQ-1"]);
    expect(calls.some((u) => u.includes("192.168.6.133"))).toBe(true);
  });

  it("没有会话时直接返回可展示错误，不请求", async () => {
    let called = 0;
    const bundle = await fetchSessionRequirements({
      sessionId: null,
      configUrl: "",
      fetchJson: async () => {
        called++;
        return {};
      },
    });
    expect(bundle.ok).toBe(false);
    expect(bundle.error).toContain("会话");
    expect(called).toBe(0);
  });

  it("全部候选不可达时返回 ok:false 而不是抛异常", async () => {
    const bundle = await fetchSessionRequirements({
      sessionId: "s1",
      configUrl: "",
      fetchJson: async () => {
        throw new Error("boom");
      },
    });
    expect(bundle.ok).toBe(false);
    expect(bundle.error).toContain("不可达");
    expect(bundle.requirements).toEqual([]);
  });

  it("会话没有绑定需求时 ok:true + 空列表", async () => {
    const bundle = await fetchSessionRequirements({
      sessionId: "s1",
      configUrl: "http://hub.test",
      fetchJson: async () => ({ ok: true, reqIds: [] }),
    });
    expect(bundle).toMatchObject({ ok: true, hubUrl: "http://hub.test", requirements: [] });
  });
});
