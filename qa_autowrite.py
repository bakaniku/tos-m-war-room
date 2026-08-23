# -*- coding: utf-8 -*-
"""網頁端 autoWrite 的離線驗證: 不需要開遊戲、不需要使用者實測.

為什麼要有這支 (2026-08-24):
    先前每次改 autoWrite 都只能請使用者「去打一場看看」, 於是同一個晚上讓他
    白跑了三次, 每次撞到不同的、我沒先驗過的東西. autoWrite 的輸入其實就是
    Firebase 上那包影子資料, 完全可以用合成資料在隔離房間裡驗完再交出去.

用法:
    python qa_autowrite.py setup     # 在 QATEST 房間鋪測試資料 (不碰正式房間)
    python qa_autowrite.py refresh   # 只更新時戳 (updated_at 有 2 分鐘的過期閘門)
    python qa_autowrite.py check     # 印出目前 QATEST 的卡片, 對照期望值
    python qa_autowrite.py clean     # 清光測試資料

搭配瀏覽器:
    1) setup
    2) 開頁面 -> 進 QATEST -> 勾「自動代寫」-> 認領四個 qa_* 偵測器
    3) refresh, 等幾秒
    4) check

期望值 (保護名單維持預設的 '184'):
    157_1 = R2   單分流圖 + 分流讀不到 -> 預設 ch1 照填   <- 這條是 1.6.2 修的
    181_2 = R4   有分流 -> 照填
    (無 184)     多分流圖 + 分流讀不到 -> 寧可不寫
    (無 163)     map_fresh=False -> 不寫
"""
import json
import sys
import time
import urllib.request

DB = "https://tos-m-fb-default-rtdb.asia-southeast1.firebasedatabase.app"
ROOM = "QATEST"          # 隔離房間, 不要改成正式房號

# (collector_id, 欄位, 期望卡片) —— 期望值 None 代表「不該被寫出來」
CASES = [
    ("qa_stage_noch",  {"map_level": 157, "map_name": "貝拉因小鎮",
                        "stage": "R2", "map_fresh": True},           "157_1"),
    ("qa_stage_multi", {"map_level": 184, "map_name": "亞夏克地牢1層",
                        "stage": "R3", "map_fresh": True},           None),
    ("qa_stage_ch2",   {"map_level": 181, "map_name": "亞夏克地牢2層",
                        "stage": "R4", "map_fresh": True, "ch": 2},  "181_2"),
    ("qa_notfresh",    {"map_level": 163, "map_name": "克利黑爾紀念區",
                        "stage": "R1", "map_fresh": False, "ch": 1}, None),
    # 小數階段保護的時效 (1.6.3): 卡片已是 R1.3 而偵測器讀到 R1 ——
    #   卡片「新鮮」-> 保護生效, 不覆蓋 (那是隊友當下手填的更精確資訊)
    #   卡片「閒置」-> 保護失效, 直接覆蓋 (陳年殘留不該擋住偵測器)
    ("qa_sub_fresh",   {"map_level": 115, "map_name": "測試A",
                        "stage": "R1", "map_fresh": True, "ch": 1},   "115_1"),
    ("qa_sub_idle",    {"map_level": 117, "map_name": "測試B",
                        "stage": "R1", "map_fresh": True, "ch": 1},   "117_1"),
    # 分流合理性 (1.6.4): 不在多分流清單裡的圖讀到 ch>=3 = 誤讀 -> 當成讀不到 -> ch1
    ("qa_ch4_single",  {"map_level": 155, "map_name": "史達里小鎮",
                        "stage": "R3", "map_fresh": True, "ch": 4},   "155_1"),
    # 對照: 在清單裡的圖 (184) 讀到 ch=3 是合法的, 要照填
    ("qa_ch3_multi",   {"map_level": 184, "map_name": "亞夏克地牢1層",
                        "stage": "R2", "map_fresh": True, "ch": 3},   "184_3"),
    # 對照: 不在清單裡但只讀到 ch=2 -> 仍然放行 (使用者: 其他圖「很難超過 2」)
    ("qa_ch2_other",   {"map_level": 173, "map_name": "星之塔21樓",
                        "stage": "R1", "map_fresh": True, "ch": 2},   "173_2"),
]
# 這兩張卡要先鋪好「既有內容」, autoWrite 才有東西可以被擋/被覆蓋
PRESEED = {
    # 新鮮的 R1.3 (startTime = 現在) -> 期望維持 R1.3
    "115_1": {"aged_s": 60,      "lastInput": "R1.3", "displayValue": "階段1.3"},
    # 閒置的 R1.3 (startTime = 3 小時前, 超過頁面的兩小時門檻) -> 期望被蓋成 R1
    "117_1": {"aged_s": 3 * 3600, "lastInput": "R1.3", "displayValue": "階段1.3"},
}
EXPECT_VALUE = {"157_1": "R2", "181_2": "R4",
                "115_1": "R1.3",   # 新鮮 -> 保護生效, 不該被動
                "117_1": "R1",     # 閒置 -> 保護失效, 該被覆蓋
                "155_1": "R3",     # ch4 被判為誤讀 -> 退回 ch1
                "184_3": "R2",     # 184 在清單裡, ch3 合法
                "173_2": "R1"}     # ch2 不受影響


def _req(path, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(f"{DB}/{path}.json", method=method, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read().decode()


def push(bind=False):
    now_ms = int(time.time() * 1000)
    iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    for cid, extra, _ in CASES:
        payload = {"collector_id": cid, "room": ROOM, "ts": iso,
                   "updated_at": now_ms, "ver": "qa"}
        payload.update(extra)
        s, _b = _req(f"shared/nativeDetector/{ROOM}/{cid}", "PUT", payload)
        line = f"  {cid:<16} {s}  ch={payload.get('ch', '(讀不到)')} " \
               f"stage={payload['stage']} fresh={payload['map_fresh']}"
        if bind:
            s2, _b2 = _req(f"shared/nativeDetectorBind/{cid}", "PUT", ROOM)
            line += f"  bind={s2}"
        print(line)


def check():
    _s, body = _req(f"rooms/{ROOM}/bosses")
    cards = json.loads(body) or {}
    got = {k: (v or {}).get("lastInput") for k, v in cards.items()}
    print(f"  實際卡片: {got if got else '(空)'}")
    ok = True
    for cid, extra, want in CASES:
        if want is None:
            # 檢查「這個案例出錯時會產生的那一格」, 不是整張地圖 ——
            # 2026-08-24 踩到: 兩個案例同樣用 184 (一個測「分流讀不到要跳過」,
            # 一個測「ch3 合法要照填」), 用 startswith 檢查會把後者合法寫出的
            # 184_3 當成前者的違規. 測試自己的判準錯了, 比被測程式錯更難發現.
            bad_key = f"{extra['map_level']}_{extra.get('ch') or 1}"
            good = bad_key not in got
            print(f"  {'OK ' if good else 'NG '} {cid:<16} 期望不寫 {bad_key}  -> "
                  f"{'沒有被寫出' if good else '竟然寫了 ' + repr(got[bad_key])}")
        else:
            good = got.get(want) == EXPECT_VALUE[want]
            print(f"  {'OK ' if good else 'NG '} {cid:<16} 期望 {want}="
                  f"{EXPECT_VALUE[want]}  -> 實際 {got.get(want)!r}")
        ok = ok and good
    print("\n  結果:", "全部通過" if ok else "★ 有不符合的項目")
    return 0 if ok else 1


def clean():
    for path in (f"rooms/{ROOM}", f"shared/nativeDetector/{ROOM}"):
        s, _b = _req(path, "DELETE")
        print(f"  刪除 {path}: {s}")
    for cid, _e, _w in CASES:
        s, _b = _req(f"shared/nativeDetectorBind/{cid}", "DELETE")
        print(f"  刪除 bind/{cid}: {s}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "setup":
        _req(f"rooms/{ROOM}/bosses", "DELETE")
        now_ms = int(time.time() * 1000)
        for cid, cfg in PRESEED.items():
            mp, ch = cid.split("_")
            _req(f"rooms/{ROOM}/bosses/{cid}", "PUT", {
                "map": mp, "ch": ch,
                "lastInput": cfg["lastInput"], "displayValue": cfg["displayValue"],
                "startTime": now_ms - cfg["aged_s"] * 1000,
                "targetTime": 0, "isMax": False, "isFlash": False,
                "callPriority": 0, "memberCount": 0, "updater": "qa",
            })
            print(f"  預鋪 {cid} = {cfg['lastInput']} (startTime {cfg['aged_s']//60} 分鐘前)")
        push(bind=True)
        print(f"\n  測試房間 = {ROOM}; 接著開頁面進這個房號, 勾自動代寫並認領 qa_* 偵測器")
    elif cmd == "refresh":
        push()
    elif cmd == "check":
        sys.exit(check())
    elif cmd == "clean":
        clean()
    else:
        print(__doc__)
        sys.exit(2)
