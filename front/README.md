# Caps Table

Svelte app for planning a bottle-cap mosaic layout.

## Data files

`static/caps.json` is the cap inventory. It stores cap types, not every physical cap:

```json
{
  "version": 2,
  "cap_types": [
    {
      "type_id": 10,
      "label": "brownbrew",
      "color": "#8b4513",
      "diameter": 30,
      "count": 140
    }
  ]
}
```

Photo datasets should reference `type_id` from `caps.json`. A dataset can contain simple type samples or annotated batch photos:

```json
{
  "version": 1,
  "samples": [
    {
      "type_id": 10,
      "images": ["dataset/brownbrew/front.jpg"]
    }
  ],
  "images": [
    {
      "src": "dataset/batch_001.jpg",
      "annotations": [
        { "type_id": 10, "bbox": [120, 80, 42, 42] }
      ]
    }
  ]
}
```

The app still accepts the older `[{ "color": "#..." }]` caps array and converts it in memory.

The `/dataset` page helps collect photo samples for these types. It stores a local draft in the browser and exports `dataset.json`.

## Developing

```bash
npm install
npm run dev
```

## Building

```bash
npm run build
```
