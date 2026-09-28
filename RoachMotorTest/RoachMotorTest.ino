#include <WiFi.h>
#include <WebServer.h>

// ==========================
// MOTOR PINS
// ==========================
const int IN1 = 25;
const int IN2 = 26;
const int IN3 = 27;
const int IN4 = 33;

// ==========================
// ULTRASONIC SENSOR
// ==========================
const int TRIG_PIN = 5;
const int ECHO_PIN = 18;

// ==========================
// WIFI
// Change these to your iPhone Hotspot
// ==========================
const char* WIFI_NAME = "kkkuang";
const char* WIFI_PASSWORD = "morris0925";

WebServer server(80);

// ==========================
// MOTOR SAFETY
// ==========================
unsigned long lastMoveTime = 0;
bool isMoving = false;

const unsigned long SAFETY_TIMEOUT_MS = 500;

// ==========================
// ULTRASONIC STATE
// ==========================
float distanceCm = -1.0;

unsigned long lastDistanceRead = 0;
const unsigned long DISTANCE_INTERVAL_MS = 120;


// ============================================================
// MOTOR CONTROL
// ============================================================

void stopMotors() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);

  isMoving = false;
}

void forward() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  isMoving = true;
}

void backward() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);

  isMoving = true;
}

void turnLeft() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);

  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  isMoving = true;
}

void turnRight() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);

  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);

  isMoving = true;
}


// ============================================================
// ULTRASONIC SENSOR
// ============================================================

void updateDistance() {

  if (millis() - lastDistanceRead < DISTANCE_INTERVAL_MS) {
    return;
  }

  lastDistanceRead = millis();

  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) {
    distanceCm = -1.0;
    return;
  }

  float measuredDistance = duration * 0.0343 / 2.0;

  if (measuredDistance < 2.0 || measuredDistance > 400.0) {
    distanceCm = -1.0;
  } else {
    distanceCm = measuredDistance;
  }
}


// ============================================================
// WEB PAGE
// ============================================================

const char PAGE[] PROGMEM = R"rawliteral(

<!doctype html>

<html>

<head>

  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>ROACH HUNTER</title>

  <style>

    body {
      font-family: -apple-system, sans-serif;
      text-align: center;
      margin: 36px;
    }

    h1 {
      margin-bottom: 6px;
    }

    p {
      color: #555;
    }

    #distance {
      margin: 18px auto;
      padding: 14px;
      max-width: 310px;
      border-radius: 12px;
      background: #ececec;
      font-size: 20px;
      font-weight: 600;
    }

    .pad {
      display: grid;
      grid-template-columns: repeat(3, 110px);
      gap: 10px;
      justify-content: center;
      margin-top: 28px;
    }

    button {
      font-size: 16px;
      font-weight: 600;
      height: 76px;
      border: 0;
      border-radius: 14px;
      background: #222;
      color: white;
      touch-action: none;
    }

    button:active {
      background: #c23;
    }

    .stop {
      background: #b21f2d;
    }

  </style>

</head>

<body>

  <h1>ROACH HUNTER</h1>

  <p>
    Hold a direction button to drive.
    Release to stop.
  </p>

  <div id="distance">
    Distance: Reading...
  </div>


  <div class="pad">

    <div></div>

    <button data-d="F">
      FORWARD
    </button>

    <div></div>


    <button data-d="L">
      LEFT
    </button>

    <button
      class="stop"
      data-d="X"
    >
      STOP
    </button>

    <button data-d="R">
      RIGHT
    </button>


    <div></div>

    <button data-d="B">
      REVERSE
    </button>

    <div></div>

  </div>


  <script>

    let timer = null;


    function send(d) {

      fetch('/cmd?d=' + d)
        .catch(() => {});

    }


    function start(d) {

      if (d === 'X') {
        stop();
        return;
      }

      send(d);

      clearInterval(timer);

      timer = setInterval(
        () => send(d),
        150
      );
    }


    function stop() {

      clearInterval(timer);

      timer = null;

      send('X');
    }


    document
      .querySelectorAll('button')
      .forEach(button => {

        const d = button.dataset.d;

        button.addEventListener(
          'pointerdown',
          event => {

            event.preventDefault();

            start(d);
          }
        );


        [
          'pointerup',
          'pointerleave',
          'pointercancel'
        ].forEach(eventName => {

          button.addEventListener(
            eventName,
            stop
          );

        });

      });


    const keys = {

      ArrowUp: 'F',

      ArrowDown: 'B',

      ArrowLeft: 'L',

      ArrowRight: 'R',

      ' ': 'X'

    };


    document.addEventListener(
      'keydown',
      event => {

        if (keys[event.key]) {

          event.preventDefault();

          if (!event.repeat) {
            start(keys[event.key]);
          }

        }

      }
    );


    document.addEventListener(
      'keyup',
      event => {

        if (keys[event.key]) {

          event.preventDefault();

          stop();

        }

      }
    );


    window.addEventListener(
      'blur',
      stop
    );


    function updateDistance() {

      fetch('/status')

        .then(response =>
          response.json()
        )

        .then(data => {

          const box =
            document.getElementById(
              'distance'
            );

          if (data.distanceCm === null) {

            box.textContent =
              'Distance: No object detected';

          } else {

            box.textContent =
              'Distance: ' +
              data.distanceCm.toFixed(1) +
              ' cm';

          }

        })

        .catch(() => {

          document
            .getElementById('distance')
            .textContent =
              'Distance: Connection lost';

        });

    }


    updateDistance();

    setInterval(
      updateDistance,
      250
    );

  </script>

</body>

</html>

)rawliteral";


// ============================================================
// HTTP COMMAND HANDLER
// ============================================================

void handleCommand() {

  String command = server.arg("d");

  if (command == "F") {
    forward();
  }

  else if (command == "B") {
    backward();
  }

  else if (command == "L") {
    turnLeft();
  }

  else if (command == "R") {
    turnRight();
  }

  else {
    stopMotors();
  }


  if (isMoving) {
    lastMoveTime = millis();
  }


  server.send(
    200,
    "text/plain",
    "OK"
  );
}


// ============================================================
// STATUS ENDPOINT
// ============================================================

void handleStatus() {

  updateDistance();


  String response =
    "{\"distanceCm\":";


  if (distanceCm < 0) {

    response += "null";

  } else {

    response +=
      String(distanceCm, 1);

  }


  response += "}";


  server.send(
    200,
    "application/json",
    response
  );
}


// ============================================================
// SETUP
// ============================================================

void setup() {

  // --------------------------
  // Serial
  // --------------------------

  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("========================");
  Serial.println("BOOTING ROACH HUNTER");
  Serial.println("========================");


  // --------------------------
  // Motor pins
  // --------------------------

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);


  // --------------------------
  // Ultrasonic pins
  // --------------------------

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);


  stopMotors();

  digitalWrite(
    TRIG_PIN,
    LOW
  );


  // ==========================================================
  // CONNECT TO IPHONE HOTSPOT
  // ==========================================================

  Serial.print(
    "Connecting to WiFi: "
  );

  Serial.println(
    WIFI_NAME
  );


  WiFi.mode(WIFI_STA);

  WiFi.begin(
    WIFI_NAME,
    WIFI_PASSWORD
  );


  // Wait for connection
  while (
    WiFi.status() != WL_CONNECTED
  ) {

    delay(500);

    Serial.print(".");
  }


  Serial.println();

  Serial.println(
    "WiFi connected!"
  );


  // THIS IS THE IMPORTANT ADDRESS
  Serial.print(
    "ESP32 IP Address: "
  );

  Serial.println(
    WiFi.localIP()
  );


  // --------------------------
  // Web server routes
  // --------------------------

  server.on(
    "/",
    []() {

      server.send_P(
        200,
        "text/html; charset=utf-8",
        PAGE
      );

    }
  );


  server.on(
    "/cmd",
    handleCommand
  );


  server.on(
    "/status",
    handleStatus
  );


  server.begin();


  Serial.println(
    "Web server started!"
  );

  Serial.println(
    "ROACH HUNTER READY"
  );

  Serial.println(
    "========================"
  );
}


// ============================================================
// MAIN LOOP
// ============================================================

void loop() {

  updateDistance();


  server.handleClient();


  // Safety:
  // if commands stop arriving,
  // stop motors automatically

  if (
    isMoving &&
    millis() - lastMoveTime >
      SAFETY_TIMEOUT_MS
  ) {

    stopMotors();

  }
}