"""本地假接入点：扮演小智云端 MCP Client，经 mcp_pipe.py 的 WebSocket 与本机 stdio 适配器对话。

第 1 次连接：initialize → tools/list → codex_submit，然后主动断开（模拟云端断线）。
第 2 次连接（mcp_pipe 自动重连）：initialize → codex_get_latest_task 轮询到完成。
每个响应以一行 JSON 打印到 stdout，供测试断言。
"""
import asyncio
import json
import sys

import websockets

PORT = int(sys.argv[1])
connections = 0
done = None  # 在事件循环内创建（Python 3.9 的 Event 绑定创建时的循环）


def emit(tag, payload):
    print(json.dumps({"tag": tag, "payload": payload}, ensure_ascii=False), flush=True)


async def rpc(ws, req_id, method, params=None):
    await ws.send(json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
        if msg.get("id") == req_id:
            return msg


async def initialize(ws):
    res = await rpc(ws, 1, "initialize", {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "fake-xiaozhi", "version": "0.0.0"},
    })
    await ws.send(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}))
    return res


def tool_payload(res):
    return json.loads(res["result"]["content"][0]["text"])


async def handler(ws):
    global connections
    connections += 1
    init = await initialize(ws)
    emit(f"initialize#{connections}", init.get("result", init.get("error")))
    if connections == 1:
        tools = await rpc(ws, 2, "tools/list")
        emit("tools", [t["name"] for t in tools["result"]["tools"]])
        submit = await rpc(ws, 3, "tools/call", {
            "name": "codex_submit",
            "arguments": {"project_id": "demo", "instruction": "概括模块职责", "client_request_id": "pipe-001"},
        })
        emit("submit", tool_payload(submit))
        await ws.close()  # 模拟云端断线；mcp_pipe 会杀掉 stdio 子进程并重连
        return
    for i in range(60):
        latest = tool_payload(await rpc(ws, 10 + i, "tools/call", {"name": "codex_get_latest_task", "arguments": {}}))
        if latest.get("status") not in ("queued", "running"):
            emit("latest", latest)
            break
        await asyncio.sleep(0.5)
    done.set()


async def main():
    global done
    done = asyncio.Event()
    async with websockets.serve(handler, "127.0.0.1", PORT):
        emit("listening", PORT)
        await asyncio.wait_for(done.wait(), timeout=60)


asyncio.run(main())
