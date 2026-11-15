"""Manual-ish Zen smoke test.

Requires geckodriver (set GECKODRIVER or put it in .output/geckodriver/).
Start the fixture server first: node test/e2e/serve-fixtures.mjs 8123
"""
import os
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

root = Path(__file__).resolve().parents[2]
zen = os.environ.get("ZEN_BINARY", r"C:\Program Files\Zen Browser\zen.exe")
geckodriver = os.environ.get(
    "GECKODRIVER",
    str(root / ".output" / "geckodriver" / "geckodriver.exe"),
)
xpi = os.environ.get(
    "PLAMO_XPI",
    str(root / ".output" / "plamo_page_translator-0.1.0.zip"),
)
url = os.environ.get("FIXTURE_URL", "http://127.0.0.1:8123/article.html")

options = Options()
options.binary_location = zen
options.set_preference("xpinstall.signatures.required", False)
options.set_preference("extensions.autoDisableScopes", 0)
options.set_preference("extensions.enabledScopes", 15)

driver = None
try:
    driver = webdriver.Firefox(options=options, service=Service(geckodriver))
    driver.install_addon(xpi, temporary=True)
    driver.get(url)
    deadline = time.time() + 40
    text = ""
    while time.time() < deadline:
        text = driver.execute_script("return document.querySelector('h1')?.textContent || ''")
        if "リージョン" in text:
            break
        time.sleep(1)
    print("H1:", text)
    print("NAV:", driver.execute_script("return document.querySelector('nav')?.textContent || ''"))
    print("MAIN_PARAGRAPH:", driver.execute_script("return document.querySelector('main p')?.textContent || ''"))
    print("LANG:", driver.execute_script("return document.querySelector('h1')?.getAttribute('lang')"))
    print("ANCHORS:", driver.execute_script("return document.querySelectorAll('main a').length"))
finally:
    if driver is not None:
        driver.quit()
