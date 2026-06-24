# На будущее: одинаковый запуск на ПК, малинке или VPS.
# Локально можно и без Docker — см. README.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "bot.py"]
