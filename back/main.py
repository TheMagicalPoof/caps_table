import json
import random
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import numpy as np

app = FastAPI()

# Разрешим фронтенду подключаться
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)



def generate_hex_coords(height, width, caps_diameter):

    dx = caps_diameter  # Горизонтальное расстояние между центрами
    dy = caps_diameter * np.sqrt(3) / 2  # Вертикальное расстояние между центрами

    cols = int(width / dx)
    rows = int(height / dy)
    cap_radius = caps_diameter / 2

    coords = []
    for row in range(rows):

        y = row * dy

        if y + cap_radius >= height:  # Если ряд выходит за пределы по оси y, пропускаем его
            continue
    
        for col in range(cols):
            x = col * dx
            if row % 2 == 1:  # сдвигаем нечетные ряды
                x += dx / 2  # сдвиг по горизонтали
                if x + cap_radius >= width:
                    continue

            if x + dx >= width:
                continue


            coords.append((x, y))
    return coords


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("АЛО ГАРАЖ")

    while True:
        try:
            init_data_raw = await websocket.receive_text()
            init_data = json.loads(init_data_raw)

            table_width = init_data.get("tableWidth")
            table_height = init_data.get("tableHeight")
            caps_diameter = init_data.get("capsDiameter")
            print(f"New Data: {table_width}x{table_height} Diameter:{caps_diameter}")

            coords = generate_hex_coords(table_height, table_width, caps_diameter)

            with open("caps.json") as f:
                caps_data = json.load(f)

            random.shuffle(caps_data)
            selected_caps = caps_data[: len(coords)]

            response = []
            for i, ((x, y), cap) in enumerate(zip(coords, selected_caps)):
                response.append({
                    "id": i,
                    "x": x,
                    "y": y,
                    "diameter": cap.get("diameter", 30),
                    "color": cap.get("color", "#cccccc"),
                    "type_id": cap.get("type_id", 0)
                })

            await websocket.send_json({
                "action": "new_table",
                "data": response
            })

        except WebSocketDisconnect:
            print("Пользователь отключился")
            break
        except Exception as e:
            print(f"Ошибка: {e}")
            break