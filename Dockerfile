FROM --platform=linux/amd64 emscripten/emsdk:4.0.7 AS build

WORKDIR /src
COPY . .

RUN --mount=type=cache,target=/src/build \
    mkdir -p build && cd build \
    && emcmake cmake .. -DPLATFORM=Web \
    && cmake --build . -- -j$(nproc) \
    && cp bin/SkyEmu.html bin/index.html \
    && cp -r bin/ /tmp/build-output

FROM python:3.12-slim

WORKDIR /app
COPY --from=build /tmp/build-output/ ./public/
COPY serve_auth.py .

ENV HOST=0.0.0.0
ENV PORT=8080
ENV SERVE_DIR=/app/public
ENV BASE_PATH=/skyemu
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["python3", "serve_auth.py"]
