import random
import json
import os



TOTAL_CAPS = 4000



# --- Псевдоданные ---
colors_pool = [
    ([0, 128, 0], "heineken"), ([255, 255, 0], "corona"), ([255, 0, 0], "bud"),
    ([0, 0, 255], "bluecap"), ([255, 165, 0], "amber"), ([128, 0, 128], "purplebrew"),
    ([255, 255, 255], "whitecap"), ([0, 0, 0], "darkbrew"), ([255, 223, 186], "blondeale"),
    ([34, 139, 34], "greenhouse"), ([139, 69, 19], "brownbrew"), ([255, 99, 71], "redbeard"),
    ([0, 191, 255], "skyblue"), ([255, 182, 193], "strawberryale"), ([255, 218, 185], "peachbrew"),
    ([186, 85, 211], "lavenderbeer"), ([255, 105, 180], "fuchsia"), ([0, 128, 128], "tealbrew"),
    ([255, 0, 255], "magentaale"), ([75, 0, 130], "indigobrew"), ([238, 130, 238], "violetbrew"),
    ([248, 248, 255], "ivorybeer"), ([189, 183, 107], "oliveale"), ([255, 250, 240], "seashellbeer"),
    ([127, 255, 0], "chartreuse"), ([255, 140, 0], "orangemania"), ([0, 255, 127], "springgreen"),
    ([255, 228, 181], "moccaale"), ([205, 133, 63], "saddlebrown"), ([128, 128, 0], "olivemax")
]

def generate_caps_json(path="caps.json", total=100):
    caps = []
    for _ in range(total):
        color, label = random.choice(colors_pool)
        caps.append({"color": color, "label": label})
    try:
        with open(path, "w") as f:
            json.dump(caps, f, indent=4)
    except OSError as e:
        print(f"Ошибка при открытии файла: {e}")

if __name__ == '__main__':
    generate_caps_json(TOTAL_CAPS)