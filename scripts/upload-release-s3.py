#!/usr/bin/env python3
"""发版产物上传 S3（rainyun 对象存储，S3 兼容）。

用法：
  python3 scripts/upload-release-s3.py <本地文件>...      # 上传到 publish/Cyrene-Agent/
  python3 scripts/upload-release-s3.py --list            # 列当前远端内容

Gitee 附件配额 1GB，S3 为第二分发渠道（无配额压力）。

S3 规范：上传【全量 tar.xz 不分卷】（直链下载+无合并步骤，配额无限）；
分卷只为 Gitee 附件单文件 100MB 限制而生。
凭证走环境变量 CYRENE_S3_AK / CYRENE_S3_SK；未设置时提示（不硬编码）。
"""
import os
import sys

import boto3

ENDPOINT = "https://cn-sy1.rains3.com"
BUCKET = "publish"
PREFIX = "Cyrene-Agent"


def main() -> None:
    ak = os.environ.get("CYRENE_S3_AK", "")
    sk = os.environ.get("CYRENE_S3_SK", "")
    if not ak or not sk:
        print("请先 export CYRENE_S3_AK / CYRENE_S3_SK")
        sys.exit(1)
    s3 = boto3.client("s3", endpoint_url=ENDPOINT,
                      aws_access_key_id=ak, aws_secret_access_key=sk)
    args = sys.argv[1:]
    if args == ["--list"]:
        r = s3.list_objects_v2(Bucket=BUCKET, Prefix=f"{PREFIX}/")
        for o in r.get("Contents", []):
            print(f"{o['Key']:64s} {o['Size'] // 1024 // 1024}MB")
        return
    if not args:
        print(__doc__)
        sys.exit(1)
    for f in args:
        if not os.path.isfile(f):
            print(f"跳过（不存在）: {f}")
            continue
        key = f"{PREFIX}/{os.path.basename(f)}"
        s3.upload_file(f, BUCKET, key)
        print(f"OK {key} ({os.path.getsize(f) // 1024 // 1024}MB)")


if __name__ == "__main__":
    main()
