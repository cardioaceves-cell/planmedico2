# Formato del plan médico (JSON)

Referencia de la estructura que el editor (`/editor`) espera para generar el plan
del paciente. Tú le pides el JSON a Claude por fuera y lo pegas en el editor; el
editor lo traduce con `mapSpanishPlan` (en `public/editor.html`) al formato que
muestra la app del paciente.

> **Atajo:** en el editor, el enlace **"Copiar instrucción para Claude →"** ya
> copia esta estructura con sus reglas. No necesitas escribirla a mano.

---

## Los 7 bloques

```
{
  "paciente":                    { datos básicos y diagnósticos }
  "medicamentos":                [ lista de fármacos ]
  "diagnostico_nutricional":     { requerimientos: {...} }
  "plan_alimenticio":            { objetivo, dias: [...] }
  "entrenamiento":               { objetivo, sesiones: [...] }
  "suplementacion":              [ suplementos ]
  "recomendaciones_especiales":  [ textos ]
}
```

## Campos por bloque

| Bloque | Campos | Regla |
|---|---|---|
| **paciente** | `nombre`, `edad`, `peso_kg`, `talla_cm`, `diagnosticos[]` | `diagnosticos` = arreglo de **textos** |
| **medicamentos** | `nombre`, `dosis`, `via`, `frecuencia`, `nota` | uno por objeto |
| **requerimientos** | `kcal_dia`, `proteina_g_dia`, `carbohidratos`, `grasas`, `fibra`, `sodio`, `liquidos` | valores con unidad |
| **plan_alimenticio** | `objetivo`, `advertencia_potasio`, `dias[]` | opciones = **texto plano** |
| **entrenamiento** | `objetivo`, `nota_seguridad`, `semanas`, `sesiones[]` | sesión: `tipo`, `frecuencia`, `duracion`, `intensidad`, `nota` |
| **suplementacion** | `nombre`, `dosis`, `momento`, `justificacion` | uno por objeto |
| **recomendaciones_especiales** | — | arreglo de **textos** |

## Reglas que evitan el bug del JSON crudo

1. **Cada opción de comida = UNA cadena de texto.** La porción/cantidad/preparación
   van dentro del mismo texto.
   - ✅ `"Avena cocida (1 taza) con manzana picada y 30 g de nuez"`
   - ❌ `{ "alimento": "Avena", "cantidad": "1 taza" }`
2. **`diagnosticos` y `recomendaciones_especiales`** también son arreglos de
   **texto**, no de objetos.
3. **Los nombres de `tiempo` deben ser exactos:** `Desayuno`, `Colacion matutina`,
   `Comida`, `Colacion vespertina`, `Cena`.
4. **`opciones` siempre es un arreglo** `[ ]`, aunque tenga una sola opción.
5. Si un dato no lo tienes, déjalo como `""` (texto vacío). No borres la estructura.

## Notas de cómo lo interpreta la app

- **Diagnósticos** se unen con ` · ` (por eso conviene listarlos por separado).
- **`via` + `frecuencia`** se combinan en el medicamento → `Oral · Cada 12 horas`.
- **Tipo de ejercicio** (cardio vs. fuerza) se detecta solo según `tipo`/`nota`.
- **Suplementos y recomendaciones** se muestran juntos en la sección de indicaciones.

---

## Ejemplo completo

Ver `ejemplo-plan.json` en esta misma carpeta — es un plan real lleno de principio
a fin, probado contra `mapSpanishPlan`, que la app renderiza limpio.
