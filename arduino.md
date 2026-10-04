#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>

// ============================================================
// MOTOR PINS
// ============================================================

const int IN1 = 25;
const int IN2 = 26;
const int IN3 = 27;
const int IN4 = 33;

// ============================================================
// SERVO
// ============================================================

const int SERVO_PIN = 13;

Servo captureServo;

const int SERVO_STOP_US = 1500;

// Capture direction
const int SERVO_CAPTURE_US = 1300;
const int SERVO_CAPTURE_TIME_MS = 2000;

// Opposite direction, used at startup
const int SERVO_READY_US = 1700;
const int SERVO_READY_TIME_MS = SERVO_CAPTURE_TIME_MS;

// ============================================================
// WIFI
// ============================================================

const char* WIFI_NAME = "ROACH-HUNTER";
const char* WIFI_PASSWORD = "roachbot123";

WebServer server(80);

// ============================================================
// MOTOR SAFETY
// ============================================================

unsigned long lastMoveTime = 0;
bool isMoving = false;

const unsigned long SAFETY_TIMEOUT_MS = 1200;

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
// MOTOR HTTP
//
// /cmd?d=F
// /cmd?d=B
// /cmd?d=L
// /cmd?d=R
// /cmd?d=X
//
// ============================================================

void handleCommand() {

String command = server.arg("d");

Serial.print("MOTOR CMD: ");
Serial.println(command);

if (command == "F") {

    forward();

} else if (command == "B") {

    backward();

} else if (command == "L") {

    turnLeft();

} else if (command == "R") {

    turnRight();

} else {

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
// CAPTURE
//
// /capture
//
// Behavior:
//
// 1. SG90 rotates in capture direction
// 2. runs for 200 ms
// 3. returns to neutral / STOP
//
// ============================================================

void handleReady() {

Serial.println();
Serial.println("========================");
Serial.println("READY START");
Serial.println("========================");

// Make sure car is not moving
stopMotors();

// Rotate opposite direction
captureServo.writeMicroseconds(
SERVO_READY_US
);

delay(
SERVO_READY_TIME_MS
);

// Stop servo
captureServo.writeMicroseconds(
SERVO_STOP_US
);

Serial.println("READY COMPLETE");

server.send(
200,
"text/plain",
"READY COMPLETE"
);
}

void handleCapture() {

Serial.println();
Serial.println("========================");
Serial.println("CAPTURE START");
Serial.println("========================");

// Make absolutely sure wheels are stopped
stopMotors();

// ----------------------------------------------------------
// START SERVO ROTATION
// ----------------------------------------------------------

Serial.print("Servo rotating at ");
Serial.print(SERVO_CAPTURE_US);
Serial.println(" us");

captureServo.writeMicroseconds(
SERVO_CAPTURE_US
);

// Rotate for configured duration
delay(
SERVO_CAPTURE_TIME_MS
);

// ----------------------------------------------------------
// STOP SERVO
// ----------------------------------------------------------

captureServo.writeMicroseconds(
SERVO_STOP_US
);

Serial.print("Servo stopped at ");
Serial.print(SERVO_STOP_US);
Serial.println(" us");

Serial.println("CAPTURE COMPLETE");
Serial.println("========================");
Serial.println();

server.send(
200,
"text/plain",
"CAPTURE COMPLETE"
);
}

// ============================================================
// OPTIONAL SERVO TEST
//
// /servo?us=1500
//
// Useful for calibration.
//
// Examples:
//
// /servo?us=1500
// /servo?us=1490
// /servo?us=1510
//
// ============================================================

void handleServo() {

if (!server.hasArg("us")) {

    server.send(
      400,
      "text/plain",
      "Missing us"
    );

    return;

}

int pulseUs =
server.arg("us").toInt();

pulseUs = constrain(
pulseUs,
1200,
1800
);

Serial.print("SERVO TEST: ");
Serial.print(pulseUs);
Serial.println(" us");

captureServo.writeMicroseconds(
pulseUs
);

server.send(
200,
"text/plain",
"OK"
);
}

// ============================================================
// ROOT
// ============================================================

void handleRoot() {

server.send(
200,
"text/plain",
"ROACH HUNTER READY"
);
}

// ============================================================
// SETUP
// ============================================================

void setup() {

Serial.begin(115200);

delay(1000);

Serial.println();
Serial.println("========================");
Serial.println("BOOTING ROACH HUNTER");
Serial.println("========================");

// ==========================================================
// MOTOR
// ==========================================================

pinMode(IN1, OUTPUT);
pinMode(IN2, OUTPUT);
pinMode(IN3, OUTPUT);
pinMode(IN4, OUTPUT);

stopMotors();

Serial.println("Motors stopped");

// ==========================================================
// SERVO
// ==========================================================

captureServo.setPeriodHertz(50);

int servoChannel = captureServo.attach(
SERVO_PIN,
500,
2400
);

Serial.print("Servo channel: ");
Serial.println(servoChannel);

// IMPORTANT:
// Servo starts in neutral / STOP.
//
// User manually places capture mechanism
// into READY position before running Python.

captureServo.writeMicroseconds(
SERVO_STOP_US
);

Serial.print("Servo initialized at STOP: ");
Serial.print(SERVO_STOP_US);
Serial.println(" us");

// ==========================================================
// WIFI
// ==========================================================

Serial.println();
Serial.println(
"Starting ROACH-HUNTER WiFi..."
);

WiFi.mode(WIFI_AP);

bool started = WiFi.softAP(
WIFI_NAME,
WIFI_PASSWORD
);

if (started) {

    Serial.println(
      "WiFi started"
    );

} else {

    Serial.println(
      "WiFi failed"
    );

}

Serial.print("WiFi Name: ");
Serial.println(WIFI_NAME);

Serial.print("IP: ");
Serial.println(
WiFi.softAPIP()
);

// ==========================================================
// SERVER ROUTES
// ==========================================================

server.on(
"/",
handleRoot
);

server.on(
"/cmd",
handleCommand
);

server.on(
"/ready",
handleReady
);

server.on(
"/capture",
handleCapture
);

server.on(
"/servo",
handleServo
);

server.begin();

// ==========================================================
// READY
// ==========================================================

Serial.println();
Serial.println(
"HTTP server started"
);

Serial.println();

Serial.println(
"Available routes:"
);

Serial.println(
"/cmd?d=F"
);

Serial.println(
"/cmd?d=B"
);

Serial.println(
"/cmd?d=L"
);

Serial.println(
"/cmd?d=R"
);

Serial.println(
"/cmd?d=X"
);

Serial.println();

Serial.println(
"/capture"
);

Serial.println();

Serial.println(
"/servo?us=1500"
);

Serial.println();

Serial.println(
"ROACH HUNTER READY"
);

Serial.println(
"========================"
);
}

// ============================================================
// LOOP
// ============================================================

void loop() {

server.handleClient();

// ==========================================================
// MOTOR WATCHDOG
//
// If Python stops sending commands for >500 ms,
// automatically stop the wheels.
// ==========================================================

if (
isMoving &&
millis() - lastMoveTime > SAFETY_TIMEOUT_MS
) {

    stopMotors();

}
}
