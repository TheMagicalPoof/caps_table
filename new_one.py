import numpy as np
import random
import matplotlib.pyplot as plt
from collections import Counter
from scipy.spatial import cKDTree
import json

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
RADIUS = CAP_DIAMETER / 2

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

def build_kdtree(coords, radius):
    tree = cKDTree(coords)
    neighbors = tree.query_ball_tree(tree, r=radius)
    return neighbors


def compute_local_cost(index, color_indices, neighbors):
    local_colors = [color_indices[n] for n in neighbors[index] if n != index]
    if not local_colors:
        return 0
    counts = Counter(local_colors)
    most_common = counts.most_common(1)[0][1]
    return len(local_colors) - most_common


def layout_cost_init(color_indices, neighbors):
    return sum(compute_local_cost(i, color_indices, neighbors) for i in range(len(color_indices)))


def layout_cost_diff(color_indices, neighbors, swap_i, swap_j, current_cost):
    affected = set(neighbors[swap_i]) | set(neighbors[swap_j]) | {swap_i, swap_j}

    old_cost = sum(compute_local_cost(i, color_indices, neighbors) for i in affected)

    # swap colors
    color_indices[swap_i], color_indices[swap_j] = color_indices[swap_j], color_indices[swap_i]

    new_cost = sum(compute_local_cost(i, color_indices, neighbors) for i in affected)

    delta = new_cost - old_cost
    return current_cost + delta





def draw_caps(ax, coords, layout, changed_indices=None, circles=None):
    if circles is None:
        circles = []
    
    if changed_indices is None:
        changed_indices = range(len(coords))  # отрисовываем все, если не указано

    for idx in changed_indices:
        # Удаляем старый круг, если он есть
        if idx < len(circles) and circles[idx] is not None:
            circles[idx].remove()

        cap = layout[idx]
        circle = plt.Circle(
            coords[idx],
            radius=RADIUS*0.8,
            color=np.array(cap['color']) / 255,
        )
        ax.add_patch(circle)

        # Убедимся, что список circles достаточно длинный
        while len(circles) <= idx:
            circles.append(None)
        circles[idx] = circle

    plt.pause(0.001)
    return circles


def simulated_annealing(coords, caps, radius=3.5, iterations=100000, temperature=1.0, cooling_rate=0.00005):
    fig, ax = plt.subplots()
    ax.set_aspect('equal')
    ax.set_ylim(-CAP_DIAMETER, TABLE_WIDTH + CAP_DIAMETER)
    ax.set_xlim(-CAP_DIAMETER, TABLE_HEIGHT + CAP_DIAMETER)

    plt.ion()

    current = caps.copy()
    color_indices = [tuple(cap['color']) for cap in current]  # simplified representation for hashing

    neighbors = build_kdtree(coords, radius)
    print(f"Среднее число соседей: {np.mean([len(n) for n in neighbors]):.2f}")
    current_cost = layout_cost_init(color_indices, neighbors)

    # Инициализируем список кругов
    circles = draw_caps(ax, coords, current)

    for step in range(iterations):
        i, j = random.sample(range(len(current)), 2)

        new_color_indices = color_indices.copy()
        new_cost = layout_cost_diff(new_color_indices, neighbors, i, j, current_cost)

        delta = new_cost - current_cost
        if delta < 0 or random.random() < np.exp(-delta / temperature):
            # apply swap
            current[i], current[j] = current[j], current[i]
            color_indices = new_color_indices
            current_cost = new_cost

            # Отрисовываем только те точки, которые были изменены
            circles = draw_caps(ax, coords, current, changed_indices=[i, j], circles=circles)

        temperature *= (1 - cooling_rate)

        if step % 1000 == 0:
            print(f"Step {step}, Cost: {current_cost:.2f}, Temperature: {temperature:.4f}")

    draw_caps(ax, coords, current, circles=circles)  # финальная отрисовка
    plt.ioff()
    plt.show()

    return current










coords = generate_hex_coords(cols, rows)

# Считываем крышечки из файла
with open("caps.json") as f:
    caps_data = json.load(f)

random.shuffle(caps_data)
caps = caps_data[:rows * cols]

final_caps = simulated_annealing(coords, caps, radius=dx+1.1, iterations=100000)
with open('table.json', 'w') as f:
    json.dump(final_caps, f)