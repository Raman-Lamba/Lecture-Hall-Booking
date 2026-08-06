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
  title: string;
  start_time: string; // ISO timestamp
  end_time: string; // ISO timestamp
  created_at: string;
}

export type RoomStatus = "available" | "booked" | "selected";
