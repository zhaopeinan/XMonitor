#!/usr/bin/env python3
"""把「域名系统」类表格清洗成 XMonitor 系统台账的导入载荷（JSON）。

表格约定（列位置与 reference/域名系统.xlsx 一致）：
  A 业务名称  B 域名  C 类型（内部运维/外部运维）  D 证书有效期结束
  E ip  F 安全域ip
右侧 H/I/J 为「服务器名 → 生产 IP / 安全域 IP」映射，用于给主表补 IP。

清洗规则：
  name            ← A 列，去首尾空白
  ops_unit        ← C 列「类型」（内部运维 / 外部运维），导入后可在页面上改成具体运维单位
  domain          ← B 列，去协议前缀 / 路径 / 参数 / 井号，转小写（服务端只接受主机名）
  domain_applied  ← 1（有域名即视为已申请域名）
  external_access ← 0（默认未开放外网；如需按「类型」映射请自行调整 EXTERNAL_BY_TYPE）
  ip              ← 主表 E/F 列；缺失时按名称精确匹配右侧映射表（含安全域 IP，逗号分隔）
  location        ← 留空
  remark          ← 证书有效期 / IP 来源 / 重复域名说明

用法：
  python3 scripts/ledger-from-xlsx.py reference/域名系统.xlsx [-o payload.json]

输出 JSON 为数组，元素可直接作为 POST /api/ledger 的请求体（source_row 字段仅供本地追溯）。
"""
import argparse
import json
import re
from datetime import datetime

import openpyxl

# 与服务端 server/src/ledger.ts 的 normalizeDomain 保持一致的格式校验
DOMAIN_LABEL = r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
DOMAIN_RE = re.compile(rf"^{DOMAIN_LABEL}(\.{DOMAIN_LABEL})+$")

# 是否按「类型」列决定「是否开放外网访问」。默认全部按未开放登记。
EXTERNAL_BY_TYPE = {"外部运维": False, "内部运维": False}


def norm_key(text: str) -> str:
    """名称匹配用：去掉所有空白并转小写（'TOTP - 崔金鹏' == 'TOTP-崔金鹏'）。"""
    return re.sub(r"\s+", "", str(text)).lower()


def clean_domain(raw: str) -> str:
    s = str(raw).strip()
    s = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", s)  # 协议前缀
    s = re.split(r"[/?#]", s, maxsplit=1)[0]  # 路径 / 参数 / 井号
    return s.lower().rstrip(".")


def fmt_date(value) -> str:
    return value.strftime("%Y-%m-%d") if isinstance(value, datetime) else str(value)


def build_payload(xlsx_path: str) -> list[dict]:
    ws = openpyxl.load_workbook(xlsx_path, data_only=True)["Sheet1"]

    main_rows = []
    for r in range(2, ws.max_row + 1):
        name = ws.cell(row=r, column=1).value
        domain_raw = ws.cell(row=r, column=2).value
        if not name or not domain_raw:
            continue
        main_rows.append(
            {
                "row": r,
                "name": str(name).strip(),
                "domain_raw": str(domain_raw).strip(),
                "type": str(ws.cell(row=r, column=3).value or "").strip(),
                "cert_expiry": fmt_date(ws.cell(row=r, column=4).value),
                "ip_raw": str(ws.cell(row=r, column=5).value or "").strip(),
                "sec_ip_raw": str(ws.cell(row=r, column=6).value or "").strip(),
            }
        )

    # 右侧「服务器名 → 生产 IP / 安全域 IP」映射（仅取有 IP 的行）
    ip_map: dict[str, tuple[str, str]] = {}
    for r in range(2, ws.max_row + 1):
        key = ws.cell(row=r, column=8).value  # H
        ip = ws.cell(row=r, column=9).value  # I
        sec_ip = ws.cell(row=r, column=10).value  # J
        if not key or not ip:
            continue
        ip_map[norm_key(key)] = (str(ip).strip(), str(sec_ip).strip() if sec_ip else "")

    domain_names: dict[str, list[str]] = {}
    for row in main_rows:
        domain_names.setdefault(clean_domain(row["domain_raw"]), []).append(row["name"])
    dups = {d: names for d, names in domain_names.items() if len(names) > 1}

    payload = []
    for row in main_rows:
        domain = clean_domain(row["domain_raw"])
        assert DOMAIN_RE.match(domain), f"域名清洗后不合法: {row['domain_raw']} -> {domain}"

        ip_parts: list[str] = []
        ip_source = ""
        if row["ip_raw"] or row["sec_ip_raw"]:
            ip_parts = [row["ip_raw"], row["sec_ip_raw"]]
            ip_source = "表格「ip」/「安全域ip」列"
        else:
            hit = ip_map.get(norm_key(row["name"]))
            if hit:
                ip_parts = [hit[0], hit[1]]
                ip_source = "表格右侧服务器映射表"
        ip = ", ".join(p for p in ip_parts if p)

        remark_parts = [f"证书有效期至 {row['cert_expiry']}"]
        if ip and "安全域" in ip_source:
            remark_parts.append(f"IP 含安全域 IP（{ip_source}）")
        elif ip:
            remark_parts.append(f"IP 取自{ip_source}")
        if domain in dups:
            others = [n for n in dups[domain] if n != row["name"]]
            remark_parts.append(f"域名与「{'、'.join(others)}」重复")

        payload.append(
            {
                "name": row["name"],
                "ops_unit": row["type"],
                "ip": ip,
                "external_access": EXTERNAL_BY_TYPE.get(row["type"], False),
                "domain_applied": True,
                "domain": domain,
                "location": "",
                "remark": "；".join(remark_parts),
                "system_id": None,
                "source_row": row["row"],
            }
        )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="生成 XMonitor 系统台账导入载荷")
    parser.add_argument("xlsx", help="域名系统表格路径")
    parser.add_argument("-o", "--out", default="ledger-payload.json", help="输出 JSON 路径")
    args = parser.parse_args()

    payload = build_payload(args.xlsx)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(f"共 {len(payload)} 条，已写入 {args.out}\n")
    for e in payload:
        print(f"[{e['source_row']:>2}] {e['name']}")
        print(f"     运维单位: {e['ops_unit'] or '（空）'}")
        print(f"     域名: {e['domain']}    IP: {e['ip'] or '（空）'}")
        print(f"     备注: {e['remark']}")


if __name__ == "__main__":
    main()
