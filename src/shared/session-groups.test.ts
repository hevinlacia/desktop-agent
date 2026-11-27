import { describe, expect, it } from "vitest";
import {
  addGroup,
  closeSession,
  ensureGroups,
  filterSessions,
  historyPage,
  historySessions,
  HISTORY_PAGE_SIZE,
  labelForPath,
  openSession,
  pruneMissing,
  removeGroup,
  renameGroup,
  setActiveGroup,
  type GroupState,
} from "./session-groups";

const base = (): GroupState => ({
  groups: [
    { id: "wms-1", path: "/home/u/Developer/company/云仓-WMS", label: "云仓-WMS" },
    { id: "tools-1", path: "/home/u/Developer/tools", label: "tools" },
  ],
  activeGroupId: "wms-1",
  openSessions: { "wms-1": ["/s/a.jsonl", "/s/b.jsonl"] },
});

describe("labelForPath", () => {
  it("取最后一段，忽略尾斜杠", () => {
    expect(labelForPath("/home/u/Developer/tools/")).toBe("tools");
    expect(labelForPath("/home/u")).toBe("u");
    expect(labelForPath("/")).toBe("/");
  });
});

describe("ensureGroups", () => {
  it("老配置（无分组）用 cwd 种一个分组并设为激活", () => {
    const state = ensureGroups({ groups: [], activeGroupId: null, openSessions: {} }, "/home/u");
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]!.path).toBe("/home/u");
    expect(state.activeGroupId).toBe(state.groups[0]!.id);
  });

  it("激活分组丢了就回落到第一个", () => {
    const state = ensureGroups({ ...base(), activeGroupId: "gone" }, "/home/u");
    expect(state.activeGroupId).toBe("wms-1");
  });
});

describe("addGroup", () => {
  it("新目录生成新分组并切过去", () => {
    const { state, group, existing } = addGroup(base(), "/home/u/Developer/tools/desktop-agent");
    expect(existing).toBe(false);
    expect(group.label).toBe("desktop-agent");
    expect(state.activeGroupId).toBe(group.id);
    expect(state.groups).toHaveLength(3);
  });

  it("目录已存在则复用，不重复建", () => {
    const { state, group, existing } = addGroup(base(), "/home/u/Developer/tools/");
    expect(existing).toBe(true);
    expect(group.id).toBe("tools-1");
    expect(state.groups).toHaveLength(2);
    expect(state.activeGroupId).toBe("tools-1");
  });
});

describe("removeGroup / setActiveGroup", () => {
  it("删当前分组后落到剩下的第一个，并清掉它的会话清单", () => {
    const next = removeGroup(base(), "wms-1");
    expect(next.groups.map((g) => g.id)).toEqual(["tools-1"]);
    expect(next.activeGroupId).toBe("tools-1");
    expect(next.openSessions["wms-1"]).toBeUndefined();
  });

  it("切到不存在的分组不生效", () => {
    const state = base();
    expect(setActiveGroup(state, "nope")).toBe(state);
  });
});

describe("openSession / closeSession", () => {
  it("打开放到最前；重复打开只挪位置不重复", () => {
    let state = openSession(base(), "wms-1", "/s/c.jsonl");
    expect(state.openSessions["wms-1"]).toEqual(["/s/c.jsonl", "/s/a.jsonl", "/s/b.jsonl"]);
    state = openSession(state, "wms-1", "/s/b.jsonl");
    expect(state.openSessions["wms-1"]).toEqual(["/s/b.jsonl", "/s/c.jsonl", "/s/a.jsonl"]);
  });

  it("关闭只从清单移除，不影响其它分组", () => {
    const state = closeSession(base(), "wms-1", "/s/a.jsonl");
    expect(state.openSessions["wms-1"]).toEqual(["/s/b.jsonl"]);
  });

  it("关闭不存在的会话是无操作", () => {
    const state = base();
    expect(closeSession(state, "wms-1", "/s/zzz.jsonl").openSessions["wms-1"]).toEqual([
      "/s/a.jsonl",
      "/s/b.jsonl",
    ]);
  });
});

describe("pruneMissing", () => {
  it("文件没了的会话从清单剔除", () => {
    const state = pruneMissing(base(), "wms-1", (p) => p === "/s/a.jsonl");
    expect(state.openSessions["wms-1"]).toEqual(["/s/a.jsonl"]);
  });

  it("都在时返回原对象（不制造无谓重渲染）", () => {
    const state = base();
    expect(pruneMissing(state, "wms-1", () => true)).toBe(state);
  });
});

describe("renameGroup", () => {
  it("只改 label，id 与 path 不变（id 是 openSessions 的 key）", () => {
    const next = renameGroup(base(), "wms-1", "  云仓新名字  ");
    const hit = next.groups.find((g) => g.id === "wms-1");
    expect(hit?.label).toBe("云仓新名字");
    expect(hit?.path).toBe("/home/u/Developer/company/云仓-WMS");
    expect(next.openSessions).toEqual(base().openSessions);
  });

  it("空白 label 与同名重命名都不产生新状态", () => {
    const state = base();
    expect(renameGroup(state, "wms-1", "   ")).toBe(state);
    expect(renameGroup(state, "wms-1", "云仓-WMS")).toBe(state);
    expect(renameGroup(state, "不存在", "x")).toBe(state);
  });
});

describe("filterSessions", () => {
  const list = [
    { path: "/s/2026-11-27T02-34-10-457Z_aaa.jsonl", name: "修复登录超时", sessionId: "session-aaa" },
    { path: "/s/2026-11-27T03-00-00-000Z_bbb.jsonl", name: "REQ-344 搜索框", sessionId: "session-bbb" },
    { path: "/other/2026-11-26_ccc.jsonl", sessionId: "session-ccc" },
  ];

  it("空查询 / 纯空白原样返回同一数组", () => {
    expect(filterSessions(list, "")).toBe(list);
    expect(filterSessions(list, "  ")).toBe(list);
  });

  it("按 name 匹配，大小写不敏感", () => {
    expect(filterSessions(list, "搜索框")).toHaveLength(1);
    expect(filterSessions(list, "req-344")).toHaveLength(1);
  });

  it("按 sessionId 片段匹配", () => {
    expect(filterSessions(list, "ccc")).toHaveLength(1);
    expect(filterSessions(list, "SESSION-CCC")).toHaveLength(1);
  });

  it("无 name 时按文件名匹配", () => {
    expect(filterSessions(list, "2026-11-26")).toHaveLength(1);
  });

  it("无命中返回空数组；先 trim 再比", () => {
    expect(filterSessions(list, "不存在的东西")).toEqual([]);
    expect(filterSessions(list, " 搜索框 ")).toHaveLength(1);
  });
});

describe("historySessions", () => {
  it("排除已打开的，按最后活跃倒序", () => {
    const all = [
      { path: "/s/a.jsonl", modifiedMs: 100 },
      { path: "/s/b.jsonl", modifiedMs: 300 },
      { path: "/s/c.jsonl", modifiedMs: 200 },
      { path: "/s/d.jsonl", modifiedMs: 400 },
    ];
    const history = historySessions(all, ["/s/b.jsonl"]);
    expect(history.map((s) => s.path)).toEqual(["/s/d.jsonl", "/s/c.jsonl", "/s/a.jsonl"]);
  });
});

describe("historyPage", () => {
  const many = Array.from({ length: 95 }, (_, i) => ({ path: `/s/${i}.jsonl`, modifiedMs: 1000 - i }));

  it("默认一页 30 条，并报告剩余", () => {
    const page = historyPage(many, HISTORY_PAGE_SIZE);
    expect(page.items).toHaveLength(30);
    expect(page.remaining).toBe(65);
    expect(page.shown).toBe(30);
  });

  it("点一次「加载更多」加一页（30 → 60 → 90）", () => {
    expect(historyPage(many, 60).items).toHaveLength(60);
    const third = historyPage(many, 90);
    expect(third.items).toHaveLength(90);
    expect(third.remaining).toBe(5);
  });

  it("不足一页时全部展示且没有剩余", () => {
    const page = historyPage(many.slice(0, 3), HISTORY_PAGE_SIZE);
    expect(page.items).toHaveLength(3);
    expect(page.remaining).toBe(0);
  });
});
