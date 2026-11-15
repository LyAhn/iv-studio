"""IV Studio helper nodes (local pack, written for the IV Studio MiniMax H3 workflow).

IV Latent Cache - keeps a latent on disk, keyed by a fingerprint of everything upstream of it in the
                  prompt, so a Seed Hunter preview survives ComfyUI's RAM-pressure cache and restarts.
                  Its input is lazy: on a hit the upstream sampler is never run.
IV Shot List    - picks one shot from a script whose shots are separated by lines of "---".
IV Free Memory  - unloads every model from the GPU, then passes its input on. IV Studio puts it just before a
                  workflow's sampler, so a big text encoder is gone before the video model loads.
"""
import gc
import hashlib
import json
import os

import torch

import comfy.model_management
import comfy.nested_tensor
import folder_paths

CACHE_DIR = "iv_latent_cache"


# Nodes that only watch the sampling and never change the result: the live preview (KJNodes' per-step pictures).
# The fingerprint looks straight through them, so a take hunted with the live preview on can be finished with it off
# (or at another preview size), and the other way round, without sampling it again.
SEE_THROUGH = {"ModelPreviewOverrideKJ"}


def _is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int))


def _through(prompt, link):
    """The link a see-through node passes on (its model input), followed until a real node."""
    for _ in range(64):
        node = prompt.get(str(link[0]))
        if not node or node.get("class_type") not in SEE_THROUGH or not _is_link(node.get("inputs", {}).get("model")):
            return link
        link = node["inputs"]["model"]
    return link


def _ancestry(prompt, start_id, see_through=True):
    """Every node upstream of start_id (inclusive), as {id: [class_type, inputs]}."""
    seen, todo = {}, [str(start_id)]
    while todo:
        nid = todo.pop()
        if nid in seen or nid not in prompt:
            continue
        node = prompt[nid]
        inputs = dict(node.get("inputs", {}))
        if see_through:
            inputs = {k: (_through(prompt, v) if _is_link(v) else v) for k, v in inputs.items()}
        seen[nid] = [node.get("class_type"), inputs]
        for value in inputs.values():
            if _is_link(value):
                todo.append(str(value[0]))
    return seen


def _fingerprint(prompt, unique_id, see_through=True):
    link = prompt[str(unique_id)]["inputs"].get("samples")
    if not (isinstance(link, list) and len(link) == 2):
        return None
    payload = {"source": [str(link[0]), link[1]], "graph": _ancestry(prompt, link[0], see_through)}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:32]


def _cached(prompt, unique_id):
    """The file this latent is cached in, if any: under today's fingerprint, else under the one versions 1-2 of this
    pack gave it (which counted the live preview node), so takes cached before the update are still found."""
    for see_through in (True, False):
        key = _fingerprint(prompt, unique_id, see_through)
        if key and os.path.isfile(_cache_path(key)):
            return _cache_path(key)
    return None


def _cache_path(key):
    return os.path.join(folder_paths.get_output_directory(), CACHE_DIR, key + ".pt")


def _pack(value):
    if isinstance(value, comfy.nested_tensor.NestedTensor):
        return {"__nested__": [t.detach().cpu() for t in value.tensors]}
    if torch.is_tensor(value):
        return value.detach().cpu()
    if isinstance(value, dict):
        return {k: _pack(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_pack(v) for v in value]
    return value


def _unpack(value, device):
    if isinstance(value, dict):
        if set(value) == {"__nested__"}:
            return comfy.nested_tensor.NestedTensor(tuple(t.to(device) for t in value["__nested__"]))
        return {k: _unpack(v, device) for k, v in value.items()}
    if torch.is_tensor(value):
        return value.to(device)
    if isinstance(value, list):
        return [_unpack(v, device) for v in value]
    return value


class IVLatentCache:
    DESCRIPTION = ("Saves the latent to output/iv_latent_cache under a fingerprint of everything upstream of it "
                   "(prompt, seed, size, mode, LoRAs, references...). Next time the same settings run, it loads "
                   "the file instead of re-sampling, even after a ComfyUI restart. Changing anything upstream "
                   "gives a new fingerprint, so a stale latent is never reused.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT", {"lazy": True}),
                "enabled": ("BOOLEAN", {"default": True, "label_on": "save + reuse", "label_off": "pass through"}),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "run"
    CATEGORY = "IV Studio"

    def check_lazy_status(self, samples=None, enabled=True, prompt=None, unique_id=None):
        if samples is None:
            if not enabled or prompt is None:
                return ["samples"]
            if _cached(prompt, unique_id) is None:
                return ["samples"]
        return []

    def run(self, samples=None, enabled=True, prompt=None, unique_id=None):
        key = _fingerprint(prompt, unique_id) if (enabled and prompt is not None) else None
        path = _cache_path(key) if key else None
        if samples is None:
            path = _cached(prompt, unique_id) or path
            data = torch.load(path, map_location="cpu", weights_only=True)
            print(f"[IV Latent Cache] reused {os.path.basename(path)}")
            return (_unpack(data, comfy.model_management.intermediate_device()),)
        if path:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            torch.save(_pack(samples), tmp)
            os.replace(tmp, path)
            print(f"[IV Latent Cache] saved {os.path.basename(path)}")
        return (samples,)


class IVShotList:
    DESCRIPTION = ("One shot per run from a script. Separate shots with a line containing only ---. "
                   "Set shot_number's control to increment and queue as many runs as there are shots; "
                   "numbers past the end wrap round to shot 1.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "script": ("STRING", {"multiline": True, "default": "Shot 1 prompt\n---\nShot 2 prompt"}),
                "shot_number": ("INT", {"default": 1, "min": 1, "max": 9999, "control_after_generate": "increment"}),
            }
        }

    RETURN_TYPES = ("STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("prompt", "shot_number", "shot_count", "label")
    FUNCTION = "pick"
    CATEGORY = "IV Studio"

    def pick(self, script, shot_number):
        shots, cur = [], []
        for line in script.splitlines():
            if line.strip() == "---":
                shots.append("\n".join(cur).strip())
                cur = []
            else:
                cur.append(line)
        shots.append("\n".join(cur).strip())
        shots = [s for s in shots if s]
        if not shots:
            raise ValueError("IV Shot List: the script has no shots")
        n = (shot_number - 1) % len(shots) + 1
        return (shots[n - 1], n, len(shots), f"shot{n:02d}")


class _Any(str):
    """A type that matches any other, so IV Free Memory can sit on any link."""

    def __ne__(self, other):
        return False


ANY = _Any("*")


class IVFreeMemory:
    """Unloads every model from the GPU once its inputs are ready, then passes value on unchanged.

    after_1 and after_2 make it wait for other branches too (a negative prompt, say), so everything that
    still needs the text encoder has run before it goes.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"value": (ANY,)}, "optional": {"after_1": (ANY,), "after_2": (ANY,)}}

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("value",)
    FUNCTION = "free"
    CATEGORY = "IV Studio"

    def free(self, value, after_1=None, after_2=None):
        comfy.model_management.unload_all_models()
        gc.collect()
        comfy.model_management.soft_empty_cache()
        return (value,)


NODE_CLASS_MAPPINGS = {"IVLatentCache": IVLatentCache, "IVShotList": IVShotList, "IVFreeMemory": IVFreeMemory}
NODE_DISPLAY_NAME_MAPPINGS = {"IVLatentCache": "IV Latent Cache", "IVShotList": "IV Shot List", "IVFreeMemory": "IV Free Memory"}
