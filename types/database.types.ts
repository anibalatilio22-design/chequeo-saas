// Tipos escritos a mano para arrancar. Reemplazar por los generados con:
//   npx supabase gen types typescript --project-id <id> --schema public
// (o `npm run db:types` una vez configurado SUPABASE_PROJECT_ID)

export type UserRole = "admin" | "operario";
export type ShipmentType = "full" | "flex" | "colecta";
export type ShipmentStatus = "open" | "closed" | "archived";

export interface Company {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  logo_url: string | null;
  created_at: string;
}

export interface AppUser {
  id: string;
  company_id: string;
  full_name: string;
  role: UserRole;
  active: boolean;
  created_at: string;
}

export interface Workstation {
  id: string;
  company_id: string;
  name: string;
  device_key: string | null;
  active: boolean;
  created_at: string;
}

export interface Operator {
  id: string;
  company_id: string;
  full_name: string;
  pin_hash: string;
  active: boolean;
  created_at: string;
}

// Catálogo estable de productos: cada uno con su EAN/SKU fijo. Es la base
// contra la que se compara un pedido nuevo, en vez de depender del Código ML
// de la etiqueta (que cambia de envío en envío).
export interface Product {
  id: string;
  company_id: string;
  ean: string | null;
  sku: string | null;
  name: string;
  active: boolean;
  created_at: string;
}

export interface Recipe {
  id: string;
  company_id: string;
  label_ean: string;
  name: string;
  active: boolean;
  // Producto final que arma esta receta (lo que se vende/pide). Es lo que se
  // compara contra un pedido nuevo para saber "qué combo es este".
  output_product_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecipeComponent {
  id: string;
  company_id: string;
  recipe_id: string;
  product_id: string | null;
  product_ean: string;
  product_sku: string | null;
  product_name: string;
  quantity: number;
  created_at: string;
}

export interface Shipment {
  id: string;
  company_id: string;
  code: string;
  type: ShipmentType;
  status: ShipmentStatus;
  created_at: string;
  closed_at: string | null;
}

export interface ShipmentItem {
  id: string;
  company_id: string;
  shipment_id: string;
  recipe_id: string;
  quantity_required: number;
  // Código ML de la etiqueta para ESTE envío puntual (cambia de envío en
  // envío, por eso vive acá y no en la receta).
  label_ean: string | null;
  created_at: string;
}

export interface ScannedComponent {
  ean: string;
  product_name: string;
  ok: boolean;
  scanned_at: string;
  quantity?: number; // cuántas unidades se confirmaron en este escaneo (1 si no está, para registros viejos)
}

export interface Completion {
  id: string;
  company_id: string;
  shipment_item_id: string;
  recipe_id: string;
  operator_id: string;
  workstation_id: string | null;
  user_id: string | null;
  scanned_components: ScannedComponent[] | null;
  completed_at: string;
}

export interface ShipmentProgress {
  shipment_item_id: string;
  shipment_id: string;
  company_id: string;
  recipe_id: string;
  recipe_name: string;
  label_ean: string;
  quantity_required: number;
  quantity_completed: number;
}

// Forma mínima que espera @supabase/ssr / supabase-js para tipar el cliente.
// Se puede ampliar con Row/Insert/Update por tabla cuando se generen los tipos reales.
//
// IMPORTANTE: cada tabla/vista necesita la clave "Relationships" (aunque sea
// vacía) porque los tipos internos de @supabase/postgrest-js la exigen para
// poder resolver bien el tipo de resultado de selects, inserts y updates. Si
// falta, TypeScript no avisa acá mismo sino en cualquier lugar del código
// donde se use esa tabla, con errores confusos tipo "no existe en el tipo
// 'never'" — que es justo lo que nos pasó al compilar en Vercel.
export interface Database {
  public: {
    Tables: {
      companies: { Row: Company; Insert: Partial<Company>; Update: Partial<Company>; Relationships: [] };
      users: { Row: AppUser; Insert: Partial<AppUser>; Update: Partial<AppUser>; Relationships: [] };
      workstations: { Row: Workstation; Insert: Partial<Workstation>; Update: Partial<Workstation>; Relationships: [] };
      operators: { Row: Operator; Insert: Partial<Operator>; Update: Partial<Operator>; Relationships: [] };
      products: { Row: Product; Insert: Partial<Product>; Update: Partial<Product>; Relationships: [] };
      recipes: { Row: Recipe; Insert: Partial<Recipe>; Update: Partial<Recipe>; Relationships: [] };
      recipe_components: {
        Row: RecipeComponent;
        Insert: Partial<RecipeComponent>;
        Update: Partial<RecipeComponent>;
        Relationships: [];
      };
      shipments: { Row: Shipment; Insert: Partial<Shipment>; Update: Partial<Shipment>; Relationships: [] };
      shipment_items: {
        Row: ShipmentItem;
        Insert: Partial<ShipmentItem>;
        Update: Partial<ShipmentItem>;
        Relationships: [];
      };
      completions: { Row: Completion; Insert: Partial<Completion>; Update: Partial<Completion>; Relationships: [] };
    };
    Views: {
      shipment_progress: { Row: ShipmentProgress; Relationships: [] };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
