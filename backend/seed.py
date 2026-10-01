"""
GPS Verify — Site Seeder
Reads the Excel seed file and writes sites.json for the backend.
Run: python seed.py
"""
import json
import os

try:
    import openpyxl
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'openpyxl', '-q'])
    import openpyxl

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# The Excel file is two levels up from backend/
EXCEL_PATH = os.path.join(SCRIPT_DIR, '..', '..', 'Seed File For Sites.xlsx')
OUT_PATH = os.path.join(SCRIPT_DIR, 'data', 'sites.json')

wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
ws = wb.active

sites = []
for row in ws.iter_rows(min_row=2, values_only=True):  # skip header
    site_id, site_name, towerco_id = row[0], row[1], row[2]
    if not towerco_id:
        continue
    # Skip rows with missing / error values
    if towerco_id is None or str(towerco_id).startswith('#') or str(towerco_id).strip() == '':
        continue
    try:
        towerco_id_str = str(int(float(towerco_id)))
    except (ValueError, TypeError):
        continue

    sites.append({
        'siteId': str(site_id or '').strip(),
        'siteName': str(site_name or '').strip(),
        'towercoId': towerco_id_str,
    })

# Write sites.json
os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
with open(OUT_PATH, 'w', encoding='utf-8') as f:
    json.dump(sites, f, indent=2, ensure_ascii=False)

print(f'[OK] Seeded {len(sites)} sites -> {OUT_PATH}')

# Also create a default admin user (password: admin123)
admin_path = os.path.join(SCRIPT_DIR, 'data', 'users.json')
import hashlib, uuid, time, bcrypt as bcrypt_lib
if not os.path.exists(admin_path):
    pw_hash = bcrypt_lib.hashpw('admin123'.encode(), bcrypt_lib.gensalt()).decode()
    admin = {
        'id': str(uuid.uuid4()),
        'username': 'admin',
        'password': pw_hash,
        'role': 'admin',
        'createdAt': __import__('datetime').datetime.now().isoformat(),
    }
    with open(admin_path, 'w') as f:
        json.dump([admin], f)
    print('[OK] Created admin user -> username: admin, password: admin123')
    print('  *** Change this password after first login!')
else:
    print('[OK] users.json already exists -- skipping admin creation')
