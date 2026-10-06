# NX GPU worker with the real engines. Build on any machine; run on an NVIDIA GPU:
#   docker build -t nx-gpu gpu-worker
#   docker run --gpus all -p 8188:8188 -v nx-models:/models \
#     -e NX_ENGINES=ltx,qwen-image-edit -e NX_GPU_TOKEN=... nx-gpu
# PyPI's Linux torch wheels bundle the CUDA runtime and cuDNN; the host only needs the NVIDIA
# driver and the NVIDIA Container Toolkit (--gpus all).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 \
    HF_HOME=/models/hf NX_GPU_MODELS_DIR=/models/nx NX_GPU_DATA_DIR=/tmp/nx-gpu PORT=8188
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-gpu.txt ./
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements-gpu.txt
COPY nx_gpu ./nx_gpu
COPY bench.py ./

RUN useradd -m nx && mkdir -p /models && chown nx /models
USER nx
VOLUME ["/models"]
EXPOSE 8188
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/venv/bin/python", "-m", "nx_gpu.server"]
