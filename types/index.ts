export type RoomType = "LT" | "CR";

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  floor: number;
  pos_x: number;
  capacity: number;
}

export interface Booking {
  id: string;
  room_id: string;
  user_id: string;
  user_name: string;
  title: string;
  start_time: string; // ISO timestamp
  end_time: string; // ISO timestamp
  created_at: string;
  status: "active" | "cancelled";
  last_edited_by: string | null;
  last_edited_reason: string | null;
  last_edited_at: string | null;
}

export type RoomStatus = "available" | "booked" | "upcoming" | "selected";

export interface Profile {
  id: string;
  role: "member" | "admin";
}
