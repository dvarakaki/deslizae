# Laboratório: mouse pela câmera olhando para o teto

> **Experimental.** Esta branch testa se o celular, deitado na mesa com a tela
> para cima, pode funcionar como um mouse de verdade usando a câmera frontal
> para acompanhar o teto.

## Ideia

Com o celular deslizando na mesa, a câmera frontal vê o teto a ~2 m. Mover o
celular desloca a imagem do teto; medindo esse deslocamento quadro a quadro,
dá para mover o cursor. A tela, virada para cima, vira os botões do mouse.

| Etapa | Como é feito |
|---|---|
| Captura | câmera frontal (640×480, até 60 fps), recorte central de 256 px |
| Deslocamento | correlação de fase com FFT 2D, passa-baixa gaussiano e ajuste sub-pixel (erro < 0,06 px nos testes) |
| Confiança | PSR (nitidez do pico de correlação) e contraste da imagem |
| Inclinação | giroscópio, com matriz aprendida por calibração |
| Cursor | mesmo protocolo do touchpad (UDP/WebRTC); o agente não muda |

## Como testar

1. No PC, nesta branch:

   ```bat
   .venv\Scripts\pip install -r requirements.txt
   .venv\Scripts\python -m deslizae --lab
   ```

2. Escaneie o QR **do laboratório** (porta 8766, HTTPS). Na primeira vez, o celular
   avisa que o certificado não é confiável: ele foi gerado no seu PC. Toque em
   **Avançado → Continuar**.
3. Toque em **Iniciar** e permita a câmera e os sensores de movimento.
4. Deite o celular com a **tela para cima**, segurando pela parte de baixo, sem
   cobrir a câmera frontal.
5. Observe as métricas antes de ligar **Enviar ao cursor**.
6. Toque em **Calibrar giroscópio** e, por 4 segundos, **incline** o celular em
   várias direções **sem deslizá-lo**.

Para testar a página sem celular: abra `http://localhost:8765/lab?t=CÓDIGO&fake=1`
no PC. Um teto sintético que anda em círculos substitui a câmera.

## Métricas

| Métrica | O que significa | Bom |
|---|---|---|
| Câmera | quadros por segundo entregues pelo navegador | ≥ 30 fps |
| Processamento | tempo do cálculo por quadro, no worker | < 15 ms |
| Latência câmera | do sensor até a página, quando o navegador informa | < 80 ms |
| Qualidade (PSR) | quanto o teto tem de textura útil | ≥ 8 (barra verde) |
| Tremor parado | deslocamento médio com o celular imóvel | < 0,15 px |

## O que reportar

- Modelo do celular e navegador.
- Valores das métricas parado e deslizando devagar.
- Como é o teto (luminárias, liso, forro) e a altura aproximada.
- Se o cursor segue o movimento e se pula ao encostar o dedo no celular, com e
  sem a calibração do giroscópio.
- Se os eixos estão certos; se não, quais opções de inverter/trocar resolveram.

## Limitações conhecidas

- Precisão cerca de 10× menor que a de um mouse óptico (~0,2–0,5 mm por pixel de imagem).
- A câmera do celular acrescenta latência (tipicamente 50–100 ms).
- Teto liso sem nada no campo de visão e ventiladores de teto inviabilizam a medida.
- Rotação do celular sobre a mesa (girar em torno do próprio eixo) ainda não é compensada.
