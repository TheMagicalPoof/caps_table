
from functools import partial
import json
import random
import numpy as np
import matplotlib.pyplot as plt
from copy import deepcopy
from math import exp
import colorsys
from matplotlib.widgets import Button
from scipy.spatial import KDTree

# --- Параметры ---
CAP_DIAMETER = 30   # мм, например
TABLE_WIDTH = 600   # мм
TABLE_HEIGHT = 2000

ITERATIONS = 100000000
VISUALIZE_EVERY = 1000

# Шаги смещения (в шестиугольной сетке)
dx = CAP_DIAMETER * np.sqrt(3) / 2
dy = CAP_DIAMETER * 0.75  # 3/4 от диаметра между центрами по вертикали

cols = int(TABLE_WIDTH / dx)
rows = int(TABLE_HEIGHT / dy)
radius = CAP_DIAMETER / 2

# --- Флаги управления ---
running = False


# --- Генерация координат гексагональной сетки (вертикальный градиент) ---
def generate_hex_coords(cols, rows):
    coords = []
    for col in range(cols):
        for row in range(rows):
            # x = col * dx
            # y = row * dy + (dy / 2 if col % 2 else 0)
            y = col * dx + (dx / 2 if row % 2 else 0)
            x = row * dy
            coords.append((x, y))
    return coords

# --- Метрика качества раскладки ---
# def layout_cost(caps, coords):
#     cost = 0
#     for i in range(len(caps)):
#         for j in range(i + 1, len(caps)):
#             c1 = np.array(caps[i]['color'])
#             c2 = np.array(caps[j]['color'])
#             dist = np.linalg.norm(np.array(coords[i]) - np.array(coords[j]))
#             color_diff = np.linalg.norm(c1 - c2)
#             cost += color_diff / (dist + 1e-5)
#     return cost

# def layout_cost(caps, coords, radius=5.0, w_grad=1.0, w_local=2.0):
#     cost = 0
#     for i in range(len(caps)):
#         c1 = np.array(caps[i]['color'])
#         coord_i = np.array(coords[i])

#         local_colors = []
#         for j in range(len(caps)):
#             if i == j:
#                 continue
#             coord_j = np.array(coords[j])
#             dist = np.linalg.norm(coord_i - coord_j)

#             # --- Градиент (мягкая смена цвета)
#             c2 = np.array(caps[j]['color'])
#             color_diff = np.linalg.norm(c1 - c2)
#             cost += w_grad * color_diff / (dist + 1e-5)

#             # --- Локальное разнообразие
#             if dist < radius:
#                 local_colors.append(tuple(c2))

#         # # --- Штраф за "острова": часто повторяющиеся цвета рядом
#         # if local_colors:
#         #     color_counts = {}
#         #     for col in local_colors:
#         #         color_counts[col] = color_counts.get(col, 0) + 1
#         #     most_common_count = max(color_counts.values())
#         #     cost += w_local * most_common_count  # чем больше повторов, тем хуже

#         if local_colors:
#             color_counts = {}
#             for col in local_colors:
#                 color_counts[col] = color_counts.get(col, 0) + 1
#             most_common_count = max(color_counts.values())
#             if most_common_count > 1:
#                 cost += w_local * (most_common_count - 1) ** 2    # квадратичный штраф

#     return cost



from scipy.spatial import cKDTree

def layout_cost(caps, coords, radius=5.0, w_grad=1.0, w_local=2.0):
    cost = 0
    coords_np = np.array(coords)
    caps_colors = np.array([cap['color'] for cap in caps])
    tree = cKDTree(coords_np)

    for i, coord in enumerate(coords_np):
        c1 = caps_colors[i]
        # Найдём соседей в радиусе
        idxs = tree.query_ball_point(coord, r=radius)

        for j in idxs:
            if i == j:
                continue
            c2 = caps_colors[j]
            dist = np.linalg.norm(coord - coords_np[j])
            color_diff = np.linalg.norm(c1 - c2)
            cost += w_grad * color_diff / (dist + 1e-5)

        if len(idxs) > 1:
            local_colors = [tuple(caps_colors[j]) for j in idxs if j != i]
            color_counts = {}
            for col in local_colors:
                color_counts[col] = color_counts.get(col, 0) + 1
            most_common = max(color_counts.values())
            if most_common > 1:
                cost += w_local * (most_common - 1) ** 2

    return cost


# --- Отрисовка ---
def update_plot(ax, caps, coords, cost=None, step=None):
    ax.clear()
    ax.set_aspect('equal')
    ax.axis('off')
    if step is not None and cost is not None:
        ax.set_title(f"Step {step}, Cost: {cost:.0f}, Total Caps: {cols * rows}")
    for (x, y), cap in zip(coords, caps):
        color = np.array(cap['color']) / 255
        circle = plt.Circle((x, y), radius * 0.9, color=color, ec='black', lw=0.2)
        ax.add_patch(circle)
    ax.set_ylim(-CAP_DIAMETER, TABLE_WIDTH + CAP_DIAMETER)
    ax.set_xlim(-CAP_DIAMETER, TABLE_HEIGHT + CAP_DIAMETER)

def on_button_clicked(btn, event):
    global running
    running = not running
    btn.label.set_text("Pause" if running else "Start")

# --- Алгоритм отжига с визуализацией ---
# def simulated_annealing(caps, coords, iterations=ITERATIONS, T_start=100.0, T_end=1.0):
#     current = caps[:]
#     best = caps[:]
#     best_cost = layout_cost(best, coords)
#     T = T_start

#     # Визуализация
#     plt.ion()
#     fig, ax = plt.subplots(figsize=(16, 6))
#     ax.set_aspect('equal')
#     ax.axis('off')

#     def update_plot(caps, step, cost):
#         ax.clear()
#         ax.set_aspect('equal')
#         ax.axis('off')
#         ax.set_title(f"Step {step}, Cost: {cost:.0f}")

#         # Визуализация стола
#         table_rect = plt.Rectangle(
#             (0, 0), TABLE_WIDTH, TABLE_HEIGHT,
#             linewidth=1.5, edgecolor='gray', facecolor='lightgray', alpha=0.3
#         )
#         ax.add_patch(table_rect)

#         for (x, y), cap in zip(coords, caps):
#             color = np.array(cap['color']) / 255
#             circle = plt.Circle(
#                 (x * dx, y * dy),
#                 CAP_DIAMETER / 2 * 0.95,
#                 color=color,
#                 ec='black',
#                 lw=0.2
#             )
#             ax.add_patch(circle)

#         ax.set_xlim(-CAP_DIAMETER, TABLE_WIDTH + CAP_DIAMETER)
#         ax.set_ylim(-CAP_DIAMETER, TABLE_HEIGHT + CAP_DIAMETER)
#         fig.canvas.draw()
#         plt.pause(0.001)


#     update_plot(current, 0, best_cost)

#     for step in range(iterations):
#         i, j = random.sample(range(len(current)), 2)
#         current[i], current[j] = current[j], current[i]

#         new_cost = layout_cost(current, coords)
#         delta = new_cost - best_cost

#         if delta < 0 or random.random() < exp(-delta / T):
#             if new_cost < best_cost:
#                 best = deepcopy(current)
#                 best_cost = new_cost
#         else:
#             current[i], current[j] = current[j], current[i]  # откат

#         T = T_start * (T_end / T_start) ** (step / iterations)

#         if step % VISUALIZE_EVERY == 0:
#             print(f"[{step}] cost = {best_cost:.2f}")
#             update_plot(current, step, best_cost)

#     plt.ioff()
#     return best

# --- Главная логика ---
def run():
    global running

    # Считываем крышечки из файла
    with open("caps.json") as f:
        caps_data = json.load(f)

    # Ограничиваем количество крышечек до cols * rows
    caps_data = caps_data[:cols * rows]

    coords = generate_hex_coords(cols, rows)
    current = deepcopy(caps_data)
    best = deepcopy(current)
    best_cost = layout_cost(best, coords)
    T = 100.0
    T_end = 1.0

    fig, ax = plt.subplots(figsize=(10, 20))
    plt.subplots_adjust(bottom=0.1)

    ax_button = plt.axes([0.4, 0.01, 0.2, 0.05])
    btn = Button(ax_button, 'Start')
    btn.on_clicked(partial(on_button_clicked, btn))

    update_plot(ax, current, coords, best_cost, 0)
    plt.pause(0.01)

    for step in range(ITERATIONS):
        plt.pause(0.01)
        if not running:
            continue

        i, j = random.sample(range(len(current)), 2)
        current[i], current[j] = current[j], current[i]

        new_cost = layout_cost(current, coords)
        delta = new_cost - best_cost

        T = 100.0 * (T_end / 100.0) ** (step / ITERATIONS)
        if delta < 0 or random.random() < exp(-delta / T):
            if new_cost < best_cost:
                best = deepcopy(current)
                best_cost = new_cost
        else:
            current[i], current[j] = current[j], current[i]

        if step % VISUALIZE_EVERY == 0:
            update_plot(ax, current, coords, best_cost, step)

    plt.ioff()
    plt.show()

run()
