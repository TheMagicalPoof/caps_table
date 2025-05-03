<script lang="ts">
  import { onMount } from 'svelte';
    
  type Cap = {
    id: number;
    x: number;
    y: number;
    color: string;
    type_id: number;
    diameter: number;
  };
    
  // Начальные размеры стола
  let tableWidth = 600; // мм
  let tableHeight = 2000; // мм
  let capsDiameter = 30; // мм

  const WS = new WebSocket('ws://localhost:8000/ws');

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D;
    
    let caps = new Map<number, Cap>();
    
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    
    let dragging = false;
    let dragStart = { x: 0, y: 0 };
    

    
    // Начальный угол поворота
    let rotation = 0;
    
  // Функция для перерисовки канваса
  function draw() {
    // Очищаем холст
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  
    // Переводим в центр канваса и применяем поворот
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);
  
    // Рисуем прямоугольник стола с обновленными размерами
    ctx.beginPath();
    ctx.rect(offsetX - capsDiameter/2 * scale , offsetY - capsDiameter/2 * scale, tableWidth * scale, tableHeight * scale);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 2;
    ctx.stroke();
  
    // Отображаем крышечки
    for (let cap of caps.values()) {
      ctx.beginPath();
      ctx.arc(cap.x * scale + offsetX, cap.y * scale + offsetY, capsDiameter * scale / 2, 0, 2 * Math.PI);
      ctx.fillStyle = cap.color;
      ctx.fill();
      ctx.stroke();
    }
  
    ctx.restore();
  }
    
    // Обработка сообщения от сервера
    function handleMessage(msg: MessageEvent) {
      const { action, data } = JSON.parse(msg.data);
      if (action === "add" || action === "update") {
        for (const cap of data) caps.set(cap.id, cap);
        draw();
        return;
      }
      
      if (action === "remove") {
        for (const cap of data) caps.delete(cap.id);
        draw();
        return;
      }

      if (action === "new_table") {
        caps.clear();        // очищаем Map
        ctx.clearRect(0, 0, canvas.width, canvas.height);  // очищаем канвас
        for (const cap of data) caps.set(cap.id, cap);
        draw();
        return;
      }

    }
    
    // Обработчик изменения размеров стола
    function updateTableSize() {
      if (WS.readyState === WebSocket.OPEN) {
        // Отправляем дефолтные значения, как только соединение установлено
        let initialData = { tableWidth, tableHeight, capsDiameter};
        WS.send(JSON.stringify(initialData));

      }

      draw();
    }
    
    // Функция поворота канваса
    function rotateCanvas() {
      rotation = (rotation + 90) % 360;
      draw();
    }
    
    
    onMount(() => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      ctx = canvas.getContext('2d')!;
      draw();
    

      WS.onmessage = handleMessage;
      
      WS.onopen = () => {

        updateTableSize();
      }

      // Wheel zoom
      canvas.addEventListener('wheel', e => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 1.1 : 0.9;
        scale *= delta;
        draw();
      });
    
      // Pan drag
      canvas.addEventListener('mousedown', e => {
        dragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
      });
    
      canvas.addEventListener('mousemove', e => {
        if (!dragging) return;
        
        // Корректировка перемещения с учётом поворота канваса
        const rad = (rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        
        let dx = e.clientX - dragStart.x;
        let dy = e.clientY - dragStart.y;
        
        // Применяем поворот к перемещению
        const rotatedDx = dx * cos + dy * sin;
        const rotatedDy = -dx * sin + dy * cos;
    
        offsetX += rotatedDx;
        offsetY += rotatedDy;
    
        dragStart = { x: e.clientX, y: e.clientY };
        draw();
      });
    
      canvas.addEventListener('mouseup', () => dragging = false);
    });
  </script>
  
  <!-- Форма для ввода размеров стола -->
  <div style="padding: 10px;">
    <label for="tableWidth">Ширина стола (мм): </label>
    <input type="number" id="tableWidth" bind:value={tableWidth} min="1" max="5000" step="10" on:input={updateTableSize} />
    
    <label for="tableHeight" style="margin-left: 20px;">Длина стола (мм): </label>
    <input type="number" id="tableHeight" bind:value={tableHeight} min="1" max="5000" step="10" on:input={updateTableSize} />

    <label for="CapDiameter" style="margin-left: 20px;">Диаметр крышек (мм): </label>
    <input type="number" id="tableHeight" bind:value={capsDiameter} min="1" max="5000" step="1" on:input={updateTableSize} />
  
    <!-- Кнопка для поворота -->
    <button on:click={rotateCanvas} style="margin-left: 10px;">Повернуть</button>
  </div>
  
  <!-- Канвас -->
  <canvas bind:this={canvas} style="border: 1px solid black;"></canvas>
  