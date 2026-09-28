#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 0.4.0 的配置迁移。

断言三件事：
  1. $DSH_HOME/cordis.patch.yml（机器级 patch）已清空 —— 否则设置页保存会被拒绝；
  2. 四台服务器已逐字段落到每个 profile 自己的 cordis.patch.yml 的 mcp-manager 条目里；
  3. 各 profile patch 里原有的条目没被破坏。

用法：python test/verify-profile-patch.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import yaml

DSH = Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")
HOME_PATCH = DSH / "cordis.patch.yml"
# 迁移前的 home patch（里面还留着四台服务器）是比对基准。
HOME_BACKUP = DSH / "cordis.patch.yml.bak-before-0.3.2"
PROFILES = {
    "desktop": (DSH / "profiles" / "desktop" / "cordis.patch.yml", "llm-deepseek"),
    "web": (DSH / "profiles" / "web" / "cordis.patch.yml", "vision-toolkit"),
}
EXPECTED_NAMES = ["node_repl", "lanhu", "dbx", "cowrork-flow"]

# 只比对「连哪台服务器」的字段。设置页一保存，DSH 就会把 servers 数组整段
# 重写成 schema 规范化形态：补全 args/cwd/url/headers 的默认值、统一引号，
# 并把 enabled 显式写出来 —— enabled 是用户在页面上的运行时意图，不是迁移
# 正确性的一部分，所以排除在比对之外。
BEHAVIOR_KEYS = ("transport", "command", "url", "args", "env", "headers", "cwd")


def behavior(server: dict) -> dict:
    # 同时把「键缺失」与「键被补成空值」视作等价：schema 规范化会写出
    # args: [] / cwd: "" / url: "" / headers: {}，原 home patch 里则没有这些键。
    return {
        key: value
        for key in BEHAVIOR_KEYS
        if (value := server.get(key)) not in (None, "", [], {})
    }

failed: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {label}")
    else:
        failed.append(label)
        print(f"  FAIL {label}" + (f" → {detail}" if detail else ""))


def load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def ids(doc) -> list:
    return [e.get("id") for e in (doc or []) if isinstance(e, dict)]


print("[1] home patch 已清空")
home = load(HOME_PATCH)
check("顶层是数组", isinstance(home, list), repr(type(home)))
check("数组为空", home == [], repr(home))
check("不再包含 mcp-manager 条目", "mcp-manager" not in ids(home), repr(ids(home)))

print("[2] 基准：迁移前的 home patch 备份")
origin = load(HOME_BACKUP)
origin_entry = next(
    (e for e in origin if isinstance(e, dict) and e.get("id") == "mcp-manager"), None
)
check("备份里能找到 mcp-manager", origin_entry is not None)
origin_servers = ((origin_entry or {}).get("config") or {}).get("servers") or []
check("备份里有 4 台", len(origin_servers) == 4, f"{len(origin_servers)}")
check(
    "名称与预期一致",
    [s.get("serverName") for s in origin_servers] == EXPECTED_NAMES,
    repr([s.get("serverName") for s in origin_servers]),
)

for name, (path, keep_id) in PROFILES.items():
    print(f"[3] profile {name} 的 patch")
    check(f"{name}: 文件存在", path.is_file(), str(path))
    if not path.is_file():
        continue
    doc = load(path)
    check(f"{name}: 顶层是数组", isinstance(doc, list), repr(type(doc)))
    entries = [e for e in (doc or []) if isinstance(e, dict) and e.get("id") == "mcp-manager"]
    check(f"{name}: 恰好一个 mcp-manager 条目", len(entries) == 1, repr(ids(doc)))
    check(f"{name}: 原有条目 {keep_id} 未被破坏", keep_id in ids(doc), repr(ids(doc)))
    if not entries:
        continue
    entry = entries[0]
    check(f"{name}: 没有用 insert（会与 bundle 撞 id）", "insert" not in entry)
    servers = (entry.get("config") or {}).get("servers") or []
    check(f"{name}: 4 台服务器", len(servers) == 4, f"{len(servers)}")
    check(
        f"{name}: 顺序与名称不变",
        [s.get("serverName") for s in servers] == EXPECTED_NAMES,
        repr([s.get("serverName") for s in servers]),
    )
    check(
        f"{name}: 连接参数与原 home patch 逐字段一致",
        [behavior(s) for s in servers] == [behavior(s) for s in origin_servers],
    )
    check(
        f"{name}: enabled 若有值必须是布尔",
        all(isinstance(s["enabled"], bool) for s in servers if "enabled" in s),
    )

print()
if failed:
    print(f"{len(failed)} FAILED: {', '.join(failed)}")
    sys.exit(1)
print("ALL PASS")
