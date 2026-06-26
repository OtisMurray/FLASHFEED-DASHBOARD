import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent

scripts = [
    "fetch_stocktwits_finviz_top_gainers_to_mongo.py",
    "fetch_bluesky_finviz_top_gainers_to_mongo.py",
    "fetch_reddit_finviz_top_gainers_to_mongo.py",
]

for script in scripts:
    print(f"\n=== Running {script} ===")
    subprocess.run([sys.executable, str(root / script)], check=False, env=os.environ.copy())
