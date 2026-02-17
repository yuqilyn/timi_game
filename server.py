#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
单机静态页 + 简易 API 服务器（无第三方依赖）

目标：
- 多人异地访问同一网站
- 玩家输入名字 + 房间码加入
- 5 人到齐后由服务器统一随机分配：4 正常 + 1 卧底
- 卧底抽取 3–5 个任务，且同类型最多计入 X 个
- 记录日志：名字、身份、任务内容（JSONL）

运行：
  python3 server.py
然后访问：
  http://localhost:5173
"""

from __future__ import annotations

import json
import os
import secrets
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, "data")
LOG_DIR = os.path.join(ROOT_DIR, "logs")
ROOMS_PATH = os.path.join(DATA_DIR, "rooms.json")
ASSIGN_LOG_PATH = os.path.join(LOG_DIR, "assignments.jsonl")


TASK_POOL = [
    # 经济类
    {"id": "eco-1", "type": "经济类", "text": "抢队友一次红/蓝"},
    {"id": "eco-2", "type": "经济类", "text": "单独吃掉别人分路的一波兵线"},
    {"id": "eco-3", "type": "经济类", "text": "结算时经济保持全队第 3 名以下"},
    {"id": "eco-4", "type": "经济类", "text": "至少抢两次buff"},
    {"id": "eco-5", "type": "经济类", "text": "至少两次队友开龙不参与"},
    # 团战类
    {"id": "tf-1", "type": "团战类", "text": "关键团战最后进场 2 次"},
    {"id": "tf-2", "type": "团战类", "text": "至少两次团战不使用大招"},
    {"id": "tf-3", "type": "团战类", "text": "至少两次次卖掉血量最低的队友"},
    {"id": "tf-4", "type": "团战类", "text": "在9-11分钟之间至少掉点1次（注意截图记录）"},
    {"id": "tf-5", "type": "团战类", "text": "一次团战先手技能空掉或打在前排"},
    # 行为类
    {"id": "act-1", "type": "行为类", "text": "单带不参团 3 次"},
    {"id": "act-2", "type": "行为类", "text": "开局交主动技能（闪现之类，不限地点，完成之后截图留证）"},
    {"id": "act-3", "type": "行为类", "text": "经济落后时主动发起一次冒险开团"},
    {"id": "act-4", "type": "行为类", "text": "一次关键守塔时选择“先清线”而非支援（不送）"},
    {"id": "act-5", "type": "行为类", "text": "至少一次给队友错误信号导致队友被抓"},
]

# 默认分路池（按 5 人标准位）
LANE_POOL = ["上路", "打野", "中路", "下路", "辅助"]


def _ensure_dirs() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    if not os.path.exists(ROOMS_PATH):
        with open(ROOMS_PATH, "w", encoding="utf-8") as f:
            json.dump({"rooms": {}}, f, ensure_ascii=False, indent=2)


def _load_rooms() -> dict:
    _ensure_dirs()
    with open(ROOMS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_rooms(data: dict) -> None:
    tmp = ROOMS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, ROOMS_PATH)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _jsonl_append(path: str, obj: dict) -> None:
    _ensure_dirs()
    line = json.dumps(obj, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def _clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


def _assign_lanes(players: list[dict], max_players: int) -> None:
    """
    为当前房间内玩家随机分配分路。

    设计思路：
    - 5 人时：刚好使用 5 个标准位置，各不重复；
    - 非 5 人时：循环使用分路名，保证每个人都有一个分路；
    - 使用 secrets 进行洗牌，保证不可预测。
    """
    if not players:
        return

    base = LANE_POOL[:]
    if max_players <= len(base):
        lanes = base[:max_players]
    else:
        lanes: list[str] = []
        i = 0
        while len(lanes) < max_players:
            lanes.append(base[i % len(base)])
            i += 1

    # 洗牌分路顺序
    for i in range(len(lanes) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        lanes[i], lanes[j] = lanes[j], lanes[i]

    for idx, p in enumerate(players):
        if idx < len(lanes):
            p["lane"] = lanes[idx]


def _draw_tasks(count: int, max_same_type: int) -> list[dict]:
    count = _clamp(int(count), 3, 5)
    max_same_type = _clamp(int(max_same_type), 1, 5)

    pool = TASK_POOL[:]
    # 使用 secrets 进行不可预测随机
    for i in range(len(pool) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        pool[i], pool[j] = pool[j], pool[i]

    type_count: dict[str, int] = {}
    picked: list[dict] = []
    for t in pool:
        used = type_count.get(t["type"], 0)
        if used >= max_same_type:
            continue
        picked.append(t)
        type_count[t["type"]] = used + 1
        if len(picked) >= count:
            break

    if len(picked) < count:
        for t in pool:
            if any(x["id"] == t["id"] for x in picked):
                continue
            picked.append(t)
            if len(picked) >= count:
                break

    return picked[:count]


def _new_room_code() -> str:
    # 6 位大写字母数字，便于口头传达
    alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    return "".join(alphabet[secrets.randbelow(len(alphabet))] for _ in range(6))


def _assign_if_ready(room: dict) -> None:
    if room.get("assigned"):
        return
    max_players = int(room.get("maxPlayers", 5))
    if len(room.get("players", [])) < max_players:
        return

    players = room["players"]
    # 先为所有玩家随机分配分路
    _assign_lanes(players, max_players)
    undercover_index = secrets.randbelow(max_players)
    tasks = _draw_tasks(room["settings"]["taskCount"], room["settings"]["maxSameType"])

    room["assigned"] = True
    room["undercoverIndex"] = undercover_index
    room["undercoverTasks"] = tasks
    room["assignedAt"] = _now_ms()

    for idx, p in enumerate(players):
        role = "卧底" if idx == undercover_index else "正常玩家"
        p["role"] = role
        p["assignedAt"] = room["assignedAt"]
        # 日志：每个玩家一行（包含卧底任务，便于管理员复盘）
        _jsonl_append(
            ASSIGN_LOG_PATH,
            {
                "ts": room["assignedAt"],
                "room": room["code"],
                "name": p["name"],
                "role": role,
                "lane": p.get("lane"),
                "tasks": tasks if role == "卧底" else [],
                "settings": room["settings"],
            },
        )


class Handler(BaseHTTPRequestHandler):
    server_version = "timi-game-server/1.0"

    def _send_json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _serve_file(self, rel_path: str) -> None:
        safe = rel_path.lstrip("/").replace("..", "")
        path = os.path.join(ROOT_DIR, safe)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if not os.path.exists(path):
            self.send_response(404)
            self.end_headers()
            return

        ctype = "text/plain; charset=utf-8"
        if path.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        elif path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif path.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"

        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/me":
            qs = parse_qs(parsed.query)
            code = (qs.get("code") or [""])[0].strip().upper()
            token = (qs.get("token") or [""])[0].strip()
            if not code or not token:
                return self._send_json(400, {"error": "缺少 code 或 token"})

            data = _load_rooms()
            room = data["rooms"].get(code)
            if not room:
                return self._send_json(404, {"error": "房间不存在"})

            _assign_if_ready(room)
            _save_rooms(data)

            players = room.get("players", [])
            me = next((p for p in players if p.get("token") == token), None)
            if not me:
                return self._send_json(403, {"error": "token 无效"})

            resp = {
                "status": "assigned" if room.get("assigned") else "waiting",
                "room": code,
                "maxPlayers": room.get("maxPlayers", 5),
                "joined": len(players),
                "name": me.get("name"),
            }
            if room.get("assigned"):
                role = me.get("role")
                resp["role"] = role
                resp["tasks"] = room.get("undercoverTasks", []) if role == "卧底" else []
                resp["settings"] = room.get("settings", {})
                resp["lane"] = me.get("lane")
            return self._send_json(200, resp)

        # 静态文件
        if parsed.path in ("/", "/index.html"):
            return self._serve_file("index.html")
        if parsed.path in ("/styles.css", "/app.js"):
            return self._serve_file(parsed.path)
        return self._serve_file(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/room":
            body = self._read_json_body()
            task_count = int(body.get("taskCount", 4))
            max_same_type = int(body.get("maxSameType", 2))
            max_players = int(body.get("maxPlayers", 5))
            max_players = _clamp(max_players, 2, 12)

            data = _load_rooms()
            # 避免碰撞
            code = _new_room_code()
            while code in data["rooms"]:
                code = _new_room_code()

            room = {
                "code": code,
                "createdAt": _now_ms(),
                "maxPlayers": max_players,
                "settings": {
                    "taskCount": _clamp(task_count, 3, 5),
                    "maxSameType": _clamp(max_same_type, 1, 5),
                },
                "players": [],
                "assigned": False,
            }
            data["rooms"][code] = room
            _save_rooms(data)
            return self._send_json(200, {"code": code, "maxPlayers": max_players, "settings": room["settings"]})

        if parsed.path == "/api/join":
            body = self._read_json_body()
            code = str(body.get("code", "")).strip().upper()
            name = str(body.get("name", "")).strip()
            if not code or not name:
                return self._send_json(400, {"error": "缺少房间码或名字"})

            data = _load_rooms()
            room = data["rooms"].get(code)
            if not room:
                return self._send_json(404, {"error": "房间不存在"})

            players = room.get("players", [])
            if any(p.get("name") == name for p in players):
                return self._send_json(409, {"error": "该名字已加入房间，请换一个名字（或加后缀）"})

            if len(players) >= int(room.get("maxPlayers", 5)):
                return self._send_json(409, {"error": "房间已满"})

            token = secrets.token_urlsafe(16)
            players.append({"name": name, "token": token, "joinedAt": _now_ms()})
            room["players"] = players

            _assign_if_ready(room)
            _save_rooms(data)

            resp = {
                "token": token,
                "status": "assigned" if room.get("assigned") else "waiting",
                "room": code,
                "maxPlayers": room.get("maxPlayers", 5),
                "joined": len(players),
                "name": name,
            }
            if room.get("assigned"):
                # 返回当前玩家身份；卧底返回任务
                idx = next((i for i, p in enumerate(players) if p.get("token") == token), -1)
                role = "卧底" if idx == int(room.get("undercoverIndex")) else "正常玩家"
                resp["role"] = role
                resp["tasks"] = room.get("undercoverTasks", []) if role == "卧底" else []
                resp["settings"] = room.get("settings", {})
                if 0 <= idx < len(players):
                    resp["lane"] = players[idx].get("lane")
            return self._send_json(200, resp)

        return self._send_json(404, {"error": "未知接口"})

    def log_message(self, fmt: str, *args) -> None:
        # 保持安静，避免刷屏；如需调试可恢复
        return


def main() -> None:
    _ensure_dirs()
    port = int(os.environ.get("PORT", "5173"))
    host = os.environ.get("HOST", "0.0.0.0")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Server running at http://{host}:{port}")
    print(f"Logs: {ASSIGN_LOG_PATH}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

