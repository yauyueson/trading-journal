import os
path = r"E:_Projects_Active\Coding	rading-journal\src\pages\AppSettings.tsx"
content = open(r"E:_Projects_Active\Coding	rading-journal\_settings_content.txt", encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(content)
print("Written, bytes:", os.path.getsize(path))
