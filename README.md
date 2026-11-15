# sebshell

Shell unificada e instalador del ecosistema `*seb` ([**hubseb**](https://github.com/PahesebPJ/hubseb), [**crewseb**](https://github.com/PahesebPJ/crewseb), [**memoseb**](https://github.com/PahesebPJ/memoseb), [**deckseb**](https://github.com/PahesebPJ/deckseb), [**memosebui**](https://github.com/PahesebPJ/memosebui) y los plugins de [herdr](https://herdr.dev)) para desarrollo mixto con **Claude Code** y **Antigravity CLI (`agy`)**.

- **Un solo instalador**: `sebshell install` instala y configura todas las herramientas en orden de dependencias y registra `sebshell` en la topología de hubseb.
- **Asistente con flechas** en el primer arranque y un banner grande `SEBSHELL`.
- **Barra inferior fija** con la ventana de contexto del orquestador, subagentes activos y salud de los servicios.
- **Perfiles de cuenta** para usar varias suscripciones de Claude (aisladas con `CLAUDE_CONFIG_DIR`).
- **Subagentes configurables**: host, modelo y esfuerzo por rol de crewseb, incluidos modelos nuevos como **Gemini 4 Hydrogen**.
- **Delegación cruzada** vía MCP (`seb_delegate`): Claude delega en agy y agy en Claude según el ruteo configurado.

## Instalación

```sh
npm install -g sebshell
sebshell            # primer arranque: asistente con flechas
```

Requiere Node.js >= 22 y, según lo que elijas, `claude`, `agy`, `herdr` y `nvim`.

## Comandos

```sh
sebshell                         # Shell interactiva (asistente en el primer arranque)
sebshell config                  # Reabre el asistente
sebshell install [--dry-run]     # Instala/configura las herramientas elegidas y registra el MCP
sebshell crew                    # Editor de host, modelo y esfuerzo por subagente
sebshell run [--host claude|agy] [--agent <rol>] [--profile <n>] "<prompt>"
sebshell profile <list|add|login|use|rm|sync>
sebshell mcp                     # Servidor MCP (seb_delegate, seb_routing)
sebshell doctor [--json]
```

Dentro de la shell: `:host claude|agy`, `:agent <rol>`, `:profile <nombre>`, `:crew`, `:new`, `:config`, `:help`, `:exit`. Ctrl+C cancela el turno en curso.

## Subagentes: host, modelo y esfuerzo

La configuración vive en crewseb (`~/.config/hubseb/crewseb-models.json`) y se edita de tres formas equivalentes:

1. **Con flechas**: `sebshell crew` o `:crew`.
2. **CLI**:
   ```sh
   crewseb models catalog --host antigravity          # modelos que ofrece agy (descubiertos en vivo)
   crewseb models set developer gemini-4-hydrogen --host antigravity --effort xhigh --tier pro
   crewseb models set code-reviewer claude-opus-5-5 --host claude --effort max
   crewseb models route developer agy                 # developer se ejecuta en agy aunque orqueste Claude
   crewseb models resolve                             # matriz efectiva por rol
   ```
3. **A mano** en el JSON, seguido de `crewseb setup`.

> [!NOTE]
> En agy, el frontmatter de los agentes solo admite los tiers `inherit|flash_lite|flash|pro`: con un ID concreto el loader descarta el agente. Por eso un modelo concreto como `gemini-4-hydrogen@xhigh` se aplica **cuando sebshell invoca el rol** (`:agent`, `run --agent`, `seb_delegate`), mientras que los subagentes que agy lanza por su cuenta usan el tier elegido con `--tier`. En Claude el modelo y el esfuerzo van directamente al frontmatter.

## Delegación cruzada (`seb_delegate`)

`sebshell install` registra `sebshell mcp` en Claude y en agy. Cuando un rol está ruteado a otro host, las directivas de crewseb indican al orquestador que use `seb_delegate`. sebshell aplica el host, el modelo, el esfuerzo y la cuenta activa, y devuelve el handoff del especialista.

Salvaguardas:
- Solo roles de crewseb.
- `cwd` confinado al proyecto (sin escape por symlinks).
- Profundidad máxima 2 (`SEBSHELL_DELEGATION_DEPTH`): el hijo de último nivel no puede volver a delegar. Claude además recibe la herramienta bloqueada; agy hereda la variable en sus servidores MCP, así que el tope también se aplica allí.
- Como máximo 2 delegaciones simultáneas, con un timeout de 15 min.
- Las variables de entorno con aspecto de secreto se eliminan.
- Nunca se cambia de cuenta si el perfil falla.

Las delegaciones que lanza el host por MCP aparecen en la barra inferior de la sesión de sebshell que lo inició (`sub N (...)`). Cada proceso del host recibe `SEBSHELL_SESSION_ID`, y `sebshell mcp` registra cada turno activo en `~/.local/state/sebshell/active/` (directorio `0700` propio; registros `0600`, que se purgan si el proceso murió o tienen más de 24 h).

El modo de permisos de los turnos delegados se elige en el asistente: `default` (no pueden editar archivos sin aprobación) o `accept-edits`.

## Perfiles de cuenta

```sh
sebshell profile add claude trabajo
sebshell profile login claude trabajo
sebshell profile use claude trabajo     # o :profile trabajo solo en la sesión
```

Cada perfil comparte por symlink `CLAUDE.md`, agentes, skills, hooks, plugins y `settings.json`, y copia los servidores MCP. Las credenciales y el estado de la cuenta quedan aislados. Los perfiles de agy esperan una verificación con una segunda cuenta, porque agy guarda la sesión en el keyring del sistema.

## Desarrollo

```sh
npm install
npm run typecheck && npm test && npm run build
```

## Licencia

MIT
