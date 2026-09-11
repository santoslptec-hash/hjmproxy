# hjmproxy — reverse proxy hjmintl.com (Render Free)

## Deploy
1. Sube este repo a GitHub/GitLab.
2. En Render: New → Blueprint → selecciona el repo (`render.yaml`).
3. Se crea el servicio `hjmproxy` en plan **free**.
4. Settings → Custom Domains → agrega `hjmintl.com` y `www.hjmintl.com`.
5. Apunta el DNS a lo que indique Render.

URL del servicio: `https://hjmproxy.onrender.com`

## Variables
| Variable | Default | Notas |
|---|---|---|
| `TARGET_URL` | `http://107.180.114.144` | Origen real (IP/host, no el dominio) |
| `PROXY_HOST` | `hjmintl.com` | Header Host hacia el origen |
| `PUBLIC_HOST` | `hjmintl.com` | Dominio público |
| `PROXY_SECURE` | `false` | `true` solo si el origen tiene HTTPS válido |

Health check: `GET /__health`

## Free plan
Se duerme tras ~15 min sin tráfico. La primera visita después puede tardar ~1 min en despertar.
