# The IV Latent Cache fingerprint looks through the live preview node (GitHub-free check, no ComfyUI or torch):
# a take hunted with the live preview on is found when finished with it off, at another preview size, or the other
# way round; anything that changes the sampling still gives a new fingerprint; a take cached by pack versions 1-2
# (fingerprint counting the preview node) is still found.
#   python test/latent-cache-key.py
import importlib.util, os, sys, tempfile, types

for name in ("torch", "comfy", "comfy.model_management", "comfy.nested_tensor", "folder_paths"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["comfy"].model_management = sys.modules["comfy.model_management"]
sys.modules["comfy"].nested_tensor = sys.modules["comfy.nested_tensor"]
out = tempfile.mkdtemp()
sys.modules["folder_paths"].get_output_directory = lambda: out
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ivpack", os.path.join(here, "..", "resources", "comfy-nodes", "ComfyUI-IV-Studio", "__init__.py"))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)

passed = 0
def check(name, ok):
    global passed
    if not ok:
        raise SystemExit(f"FAIL {name}")
    passed += 1
    print(f"ok - {name}")

def take(preview=None, seed=7):
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "h3.safetensors"}},
        "14": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["9", 0]}},
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": "a porch"}},
        "20": {"class_type": "SamplerCustomAdvanced", "inputs": {"guider": ["14", 0], "noise": ["21", 0]}},
        "21": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "30": {"class_type": "IVLatentCache", "inputs": {"samples": ["20", 0], "enabled": True}},
    }
    if preview:
        g["iv_live"] = {"class_type": "ModelPreviewOverrideKJ", "inputs": {"model": ["1", 0], "max_resolution": preview, "tiny_vae": "taeh3.safetensors"}}
        g["14"]["inputs"]["model"] = ["iv_live", 0]
    return g

fp = lambda g, see=True: pack._fingerprint(g, "30", see)
check("live preview on, off, or at another size: the same take", fp(take()) == fp(take(448)) == fp(take(640)))
check("a different seed is a different take", fp(take(448)) != fp(take(448, seed=8)))
check("the old fingerprint counted the preview node", fp(take(448), False) != fp(take(), False))

# a take cached by versions 1-2 with the preview on is found when finishing with it off
old = pack._cache_path(fp(take(448), False))
os.makedirs(os.path.dirname(old), exist_ok=True)
open(old, "wb").close()
check("an old cache file (preview counted) is still found", pack._cached(take(448), "30") == old)
new = pack._cache_path(fp(take()))
open(new, "wb").close()
check("today's fingerprint wins once it exists", pack._cached(take(640), "30") == new)
print(f"\n{passed} passed")
